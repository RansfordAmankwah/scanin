import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type pg from 'pg';
import { z } from 'zod';
import { writeAudit } from '../audit.js';
import { keyedHash } from '../auth/crypto.js';
import { hit } from '../auth/rateLimit.js';
import { STUDENT_ONLY } from '../authz/index.js';
import type { Config } from '../config.js';
import { TransientDbError } from '../db/pool.js';
import { verifyToken, type Keyring } from '../qr/token.js';
import { checkIn, type RejectionReason } from './service.js';

const PER_STUDENT_PER_MINUTE = 10;
/** Campus Wi-Fi puts many students behind one address, so the per-IP ceiling is generous. */
const PER_IP_PER_MINUTE = 600;

const Body = z.object({
  token: z.string().min(1).max(200),
  clientAttemptId: z.string().uuid(),
  /** The browser's random device id. Optional so an older cached app still works. */
  deviceId: z.string().uuid().optional(),
});

const STATUS_FOR_REASON: Record<RejectionReason, number> = {
  INVALID_CODE: 400,
  CODE_EXPIRED: 410,
  CODE_REVOKED: 410,
  SESSION_NOT_STARTED: 409,
  SESSION_CLOSED: 409,
  SESSION_ENDED: 409,
  DEVICE_ALREADY_USED: 403,
};

const MESSAGE_FOR_REASON: Record<RejectionReason, string> = {
  INVALID_CODE: 'This is not a valid check-in code.',
  CODE_EXPIRED: 'This code has expired. Scan the code currently on the screen.',
  CODE_REVOKED: 'This code was cancelled by your lecturer. Scan the code currently on the screen.',
  SESSION_NOT_STARTED: 'Check-in has not started yet.',
  SESSION_CLOSED: 'Check-in is closed for this class.',
  SESSION_ENDED: 'This class has ended.',
  DEVICE_ALREADY_USED:
    'This device has already been used to check in another account for this session.',
};

/** Coarse browser family only; the full user-agent string is never stored. */
export function userAgentFamily(ua: string | undefined): string {
  if (!ua) return 'Unknown';
  if (/SamsungBrowser/i.test(ua)) return 'Samsung Internet';
  if (/Edg\//i.test(ua)) return 'Edge';
  if (/Firefox|FxiOS/i.test(ua)) return 'Firefox';
  if (/Chrome|CriOS/i.test(ua)) return 'Chrome';
  if (/Safari/i.test(ua)) return 'Safari';
  return 'Other';
}

export function registerCheckInRoutes(
  app: FastifyInstance,
  deps: { pool: pg.Pool; config: Pick<Config, 'IP_HASH_SECRET' | 'DEVICE_POLICY'>; keyring: Keyring },
): void {
  const { pool, config, keyring } = deps;

  const send = (
    reply: FastifyReply,
    status: number,
    code: string,
    message: string,
    extra: object = {},
  ) => reply.code(status).send({ error: { code, message, ...extra } });

  app.post(
    '/checkins',
    { config: { authz: { roles: STUDENT_ONLY } } },
    async (req: FastifyRequest, reply) => {
      // The student is always the signed-in account; nothing in the body can name someone else.
      const studentId = req.auth?.userId as string;
      const ipHash = keyedHash(config.IP_HASH_SECRET, 'ip', req.ip);

      const [mine, shared] = await Promise.all([
        hit(pool, `checkin:user:${studentId}`, 60),
        hit(pool, `checkin:ip:${ipHash.toString('hex')}`, 60),
      ]);
      if (mine.count > PER_STUDENT_PER_MINUTE || shared.count > PER_IP_PER_MINUTE) {
        const retryAfterSeconds = Math.max(mine.retryAfterSeconds, shared.retryAfterSeconds);
        void reply.header('Retry-After', String(retryAfterSeconds));
        return send(reply, 429, 'RATE_LIMITED', 'Too many scans. Wait a moment and try again.', {
          retryAfterSeconds,
        });
      }

      const body = Body.safeParse(req.body);
      if (!body.success) return send(reply, 400, 'INVALID_REQUEST', 'Scan the QR code again.');

      // Signature first, with no database access: forged or garbled codes stop here.
      const verified = verifyToken(keyring, body.data.token);
      if (!verified.ok) {
        await writeAudit(pool, {
          class: 'SECURITY',
          actorType: 'STUDENT',
          actorUserId: studentId,
          action: 'QR_CODE_REJECTED',
          outcome: 'DENIED',
          requestId: req.id,
          summary: { reason: verified.reason },
          ipHash,
        });
        return send(reply, 400, 'INVALID_CODE', MESSAGE_FOR_REASON.INVALID_CODE);
      }

      try {
        const result = await checkIn(pool, {
          studentId,
          token: verified.payload,
          clientAttemptId: body.data.clientAttemptId,
          ipHash,
          userAgentFamily: userAgentFamily(req.headers['user-agent']),
          deviceHash: body.data.deviceId
            ? keyedHash(config.IP_HASH_SECRET, 'device', body.data.deviceId)
            : null,
          devicePolicy: config.DEVICE_POLICY,
        });

        if (result.kind === 'REJECTED') {
          return send(
            reply,
            STATUS_FOR_REASON[result.reason],
            result.reason,
            MESSAGE_FOR_REASON[result.reason],
          );
        }
        const { kind, ...record } = result;
        return reply.code(kind === 'RECORDED' ? 201 : 200).send({ result: kind, ...record });
      } catch (err) {
        if (err instanceof TransientDbError) {
          // Nothing was recorded as far as the student is concerned; retrying with the same
          // clientAttemptId is safe and returns the original result if it did commit.
          void reply.header('Retry-After', '2');
          return send(
            reply,
            503,
            'TRY_AGAIN',
            'Could not record your check-in just now. Please try again.',
          );
        }
        throw err;
      }
    },
  );
}

import type { FastifyInstance, FastifyReply } from 'fastify';
import type pg from 'pg';
import { courseRetainUntil, writeAudit } from '../audit.js';
import { LECTURER_ONLY } from '../authz/index.js';
import { hit } from '../auth/rateLimit.js';
import type { Config } from '../config.js';
import { withTransaction } from '../db/pool.js';
import { effectiveState, lockSession, SessionError } from '../sessions/service.js';
import { mintToken, type Keyring } from './token.js';

const COURSE_ROUTE = { config: { authz: { roles: LECTURER_ONLY, course: 'courseId' } } };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Headroom for several displays and retries at a 15 s refresh: 12/min is comfortably above need. */
const MINT_LIMIT_PER_MINUTE = 12;

const notFound = (reply: FastifyReply) =>
  reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Not found.' } });

export function registerQrRoutes(
  app: FastifyInstance,
  deps: {
    pool: pg.Pool;
    config: Pick<Config, 'APP_ORIGIN' | 'QR_TOKEN_TTL_SECONDS'>;
    keyring: Keyring;
  },
): void {
  const { pool, config, keyring } = deps;

  /**
   * Issues a fresh signed code for the lecturer's display. Stateless: it writes nothing and
   * changes no session state or deadline. Only available while check-in is open.
   */
  app.get('/courses/:courseId/sessions/:sessionId/qr', COURSE_ROUTE, async (req, reply) => {
    const { courseId, sessionId } = req.params as { courseId: string; sessionId: string };
    if (!UUID.test(sessionId)) return notFound(reply);

    const limit = await hit(pool, `qr-mint:${req.auth?.userId}:${sessionId}`, 60);
    if (limit.count > MINT_LIMIT_PER_MINUTE) {
      void reply.header('Retry-After', String(limit.retryAfterSeconds));
      return reply.code(429).send({
        error: {
          code: 'RATE_LIMITED',
          message: 'Too many requests.',
          retryAfterSeconds: limit.retryAfterSeconds,
        },
      });
    }

    const { rows } = await pool.query<{
      state: string;
      open: boolean;
      now_ms: string;
      deadline_text: string | null;
    }>(
      `SELECT CASE WHEN state = 'CHECK_IN_OPEN' AND clock_timestamp() >= check_in_deadline
                   THEN 'CHECK_IN_CLOSED' ELSE state::text END AS state,
              (state = 'CHECK_IN_OPEN' AND clock_timestamp() < check_in_deadline) AS open,
              floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint AS now_ms,
              to_char(check_in_deadline AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS deadline_text
         FROM class_sessions WHERE id = $1 AND course_id = $2`,
      [sessionId, courseId],
    );
    const s = rows[0];
    if (!s) return notFound(reply);
    if (!s.open) {
      return reply.code(409).send({
        error: {
          code: 'CHECK_IN_NOT_OPEN',
          message: 'Check-in is not open for this session.',
          state: s.state,
        },
      });
    }

    const minted = mintToken(
      keyring,
      sessionId,
      Number(s.now_ms),
      config.QR_TOKEN_TTL_SECONDS * 1000,
    );
    // The code is a short-lived credential: never cache it.
    void reply.header('Cache-Control', 'no-store');
    return {
      token: minted.token,
      // The token rides in the URL fragment, so it is never sent to a server by a plain navigation.
      qrUrl: `${config.APP_ORIGIN}/c#t=${minted.token}`,
      issuedAt: new Date(minted.issuedAtMs).toISOString(),
      expiresAt: new Date(minted.expiresAtMs).toISOString(),
      // Refresh once per lifetime so the code on screen is always current and never blanks between
      // mints; a scan of the code just replaced is still accepted for one more window at check-in.
      refreshAfterSeconds: config.QR_TOKEN_TTL_SECONDS,
      checkInDeadline: s.deadline_text,
    };
  });

  /**
   * "Invalidate issued codes": every code minted before this instant stops working. The check-in
   * window and deadline are untouched, and the display simply fetches a fresh code.
   */
  app.post(
    '/courses/:courseId/sessions/:sessionId/qr/invalidate',
    COURSE_ROUTE,
    async (req, reply) => {
      const { courseId, sessionId } = req.params as { courseId: string; sessionId: string };
      if (!UUID.test(sessionId)) return notFound(reply);
      const actorId = req.auth?.userId as string;

      try {
        const invalidatedAt = await withTransaction(pool, async (c) => {
          const s = await lockSession(c, courseId, sessionId);
          const state = effectiveState(s);
          if (state !== 'CHECK_IN_OPEN') {
            throw new SessionError(
              409,
              'CHECK_IN_NOT_OPEN',
              'Check-in is not open for this session.',
              state,
            );
          }
          const { rows } = await c.query<{ at: string }>(
            `UPDATE class_sessions SET qr_not_before = clock_timestamp() WHERE id = $1
           RETURNING to_char(qr_not_before AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS at`,
            [sessionId],
          );
          await writeAudit(c, {
            class: 'DOMAIN',
            actorType: 'LECTURER',
            actorUserId: actorId,
            action: 'QR_CODES_INVALIDATED',
            courseId,
            sessionId,
            entityType: 'class_session',
            entityId: sessionId,
            retainUntil: await courseRetainUntil(c, courseId),
          });
          return rows[0]?.at as string;
        });
        return { invalidatedAt };
      } catch (err) {
        if (err instanceof SessionError) {
          return reply
            .code(err.status)
            .send({ error: { code: err.code, message: err.message, state: err.state } });
        }
        throw err;
      }
    },
  );
}

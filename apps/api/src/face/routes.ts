import type { FastifyInstance, FastifyReply } from 'fastify';
import type pg from 'pg';
import { z } from 'zod';
import { keyedHash } from '../auth/crypto.js';
import { hit } from '../auth/rateLimit.js';
import { LECTURER_ONLY, STUDENT_ONLY } from '../authz/index.js';
import type { Config } from '../config.js';
import {
  completeEnrollment,
  exportFor,
  FaceError,
  grantConsent,
  issueChallenge,
  openEnrollmentSession,
  pilotMetrics,
  privacyFor,
  retryPendingFaceDeletions,
  submitFaceCheck,
  withdrawConsent,
  type FaceConfig,
} from './service.js';
import type { FaceVerifier } from './verifier.js';

const STUDENT_ROUTE = { config: { authz: { roles: STUDENT_ONLY } } };
const COURSE_ROUTE = { config: { authz: { roles: LECTURER_ONLY, course: 'courseId' } } };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HOUR = 60 * 60;

// Frames are opaque capture blobs. We cap how many and how large, and NEVER log or persist them.
const CompleteBody = z.object({
  frames: z.array(z.string().max(200_000)).min(1).max(30),
});
const OpenBody = z.object({
  linkId: z.string().uuid(),
  idMethod: z.enum(['STUDENT_ID_CARD', 'OTHER_OFFICIAL_ID']),
});
const ChallengeBody = z.object({ attendanceId: z.string().uuid() });
// The check upload: frames (opaque, never logged) and the device id that made the check-in.
const FramesBody = z.object({
  frames: z.array(z.string().max(200_000)).min(1).max(30),
  deviceId: z.string().uuid(),
});

function handle(reply: FastifyReply, err: unknown) {
  if (err instanceof FaceError) {
    return reply
      .code(err.status)
      .send({ error: { code: err.code, message: err.message, ...err.extra } });
  }
  throw err;
}

const notFound = (reply: FastifyReply) =>
  reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Not found.' } });

export function registerFaceRoutes(
  app: FastifyInstance,
  deps: {
    pool: pg.Pool;
    config: Pick<
      Config,
      | 'IP_HASH_SECRET'
      | 'FACE_NOTICE_VERSION'
      | 'FACE_ENROLLMENT_SESSION_TTL_SECONDS'
      | 'FACE_TEMPLATE_KEY'
      | 'FACE_CHALLENGE_TTL_SECONDS'
      | 'FACE_MATCH_THRESHOLD'
      | 'FACE_MAX_ATTEMPTS'
    >;
    verifier: FaceVerifier;
  },
): void {
  const { pool, config, verifier } = deps;
  const cfg: FaceConfig = {
    verifier,
    templateKey: config.FACE_TEMPLATE_KEY,
    noticeVersion: config.FACE_NOTICE_VERSION,
    enrollmentTtlSeconds: config.FACE_ENROLLMENT_SESSION_TTL_SECONDS,
    challengeTtlSeconds: config.FACE_CHALLENGE_TTL_SECONDS,
    matchThreshold: config.FACE_MATCH_THRESHOLD,
    maxAttempts: config.FACE_MAX_ATTEMPTS,
  };
  const deviceHashOf = (deviceId: string) => keyedHash(config.IP_HASH_SECRET, 'device', deviceId);
  const actor = (req: { auth: { userId: string } | null }) => req.auth?.userId as string;
  const ipHashOf = (req: { ip: string }) => keyedHash(config.IP_HASH_SECRET, 'ip', req.ip);

  async function limited(reply: FastifyReply, key: string, max: number, windowSeconds = HOUR) {
    const state = await hit(pool, key, windowSeconds);
    if (state.count <= max) return false;
    void reply.header('Retry-After', String(state.retryAfterSeconds));
    void reply.code(429).send({
      error: { code: 'RATE_LIMITED', message: 'Too many requests. Wait a moment and try again.' },
    });
    return true;
  }

  /** With the per-course flag off, the course behaves exactly as before: the route is simply absent. */
  async function faceEnabled(courseId: string): Promise<boolean> {
    const { rows } = await pool.query<{ on: boolean }>(
      'SELECT face_verification_enabled AS on FROM courses WHERE id = $1',
      [courseId],
    );
    return rows[0]?.on === true;
  }

  // --- The student's own privacy view and export -------------------------------------------------
  app.get('/me/privacy', STUDENT_ROUTE, async (req) => {
    // Opportunistically finish any deletion the vendor could not confirm earlier.
    await retryPendingFaceDeletions(pool, cfg).catch(() => undefined);
    return privacyFor(pool, cfg, actor(req));
  });

  app.get('/me/privacy/export', STUDENT_ROUTE, async (req, reply) => {
    const data = await exportFor(pool, cfg, actor(req));
    void reply.header('Content-Type', 'application/json; charset=utf-8');
    void reply.header('Content-Disposition', 'attachment; filename="scanin-face-data.json"');
    void reply.header('Cache-Control', 'no-store');
    return data;
  });

  // --- Consent ----------------------------------------------------------------------------------
  app.post('/me/biometric-consent', STUDENT_ROUTE, async (req, reply) => {
    if (await limited(reply, `face-consent:${actor(req)}`, 30)) return;
    const consent = await grantConsent(pool, cfg, { studentId: actor(req), ipHash: ipHashOf(req) });
    return { consent };
  });

  app.post('/me/biometric-consent/withdraw', STUDENT_ROUTE, async (req, reply) => {
    if (await limited(reply, `face-consent:${actor(req)}`, 30)) return;
    const result = await withdrawConsent(pool, cfg, {
      studentId: actor(req),
      ipHash: ipHashOf(req),
    });
    // Never claim the template is gone unless the vendor confirmed it; the privacy page keeps watching.
    return {
      consent: result.consent,
      templateDeleted: result.hadEnrollment ? result.deletionConfirmed : null,
    };
  });

  // --- Enrollment: the student completes capture on their own device -----------------------------
  app.post('/me/face-enrollments/:sessionId/complete', STUDENT_ROUTE, async (req, reply) => {
    const { sessionId } = req.params as { sessionId: string };
    if (!UUID.test(sessionId)) return notFound(reply);
    if (await limited(reply, `face-enroll:${actor(req)}`, 20)) return;
    const body = CompleteBody.safeParse(req.body);
    // The body carries frames; the error says nothing about them.
    if (!body.success)
      return reply
        .code(400)
        .send({ error: { code: 'INVALID_REQUEST', message: 'Capture again.' } });
    try {
      const { enrolledAt } = await completeEnrollment(pool, cfg, {
        studentId: actor(req),
        sessionId,
        frames: body.data.frames,
      });
      return reply.code(201).send({ enrolledAt });
    } catch (err) {
      return handle(reply, err);
    }
  });

  // --- Face check after a check-in: get a challenge, then upload a capture ------------------------
  app.post('/me/face-checks/challenge', STUDENT_ROUTE, async (req, reply) => {
    if (await limited(reply, `face-check:${actor(req)}`, 120)) return;
    const body = ChallengeBody.safeParse(req.body);
    if (!body.success)
      return reply
        .code(400)
        .send({ error: { code: 'INVALID_REQUEST', message: 'Check in first.' } });
    try {
      const r = await issueChallenge(pool, cfg, {
        studentId: actor(req),
        attendanceId: body.data.attendanceId,
      });
      if (r.kind === 'EXEMPT') return { outcome: 'EXEMPT' as const };
      return { challengeId: r.challengeId, content: r.content, expiresAt: r.expiresAt };
    } catch (err) {
      return handle(reply, err);
    }
  });

  app.post('/me/face-checks/:challengeId/frames', STUDENT_ROUTE, async (req, reply) => {
    const { challengeId } = req.params as { challengeId: string };
    if (!UUID.test(challengeId)) return notFound(reply);
    if (await limited(reply, `face-check:${actor(req)}`, 120)) return;
    const body = FramesBody.safeParse(req.body);
    // The body carries frames; the error never echoes them.
    if (!body.success)
      return reply
        .code(400)
        .send({ error: { code: 'INVALID_REQUEST', message: 'Capture again.' } });
    try {
      const r = await submitFaceCheck(pool, cfg, {
        studentId: actor(req),
        challengeId,
        deviceHash: deviceHashOf(body.data.deviceId),
        frames: body.data.frames,
      });
      return r;
    } catch (err) {
      return handle(reply, err);
    }
  });

  // --- Supervised enrollment: a lecturer opens a session after checking ID -----------------------
  app.post('/courses/:courseId/face-enrollments', COURSE_ROUTE, async (req, reply) => {
    const { courseId } = req.params as { courseId: string };
    if (!(await faceEnabled(courseId))) return notFound(reply); // unchanged behaviour when off
    if (await limited(reply, `face-open:${actor(req)}`, 120)) return;
    const body = OpenBody.safeParse(req.body);
    if (!body.success)
      return reply
        .code(400)
        .send({ error: { code: 'INVALID_REQUEST', message: 'Check the form.' } });

    const link = await pool.query<{ student_id: string }>(
      'SELECT student_id FROM roster_links WHERE id = $1 AND course_id = $2',
      [body.data.linkId, courseId],
    );
    const studentId = link.rows[0]?.student_id;
    if (!studentId) return notFound(reply);

    try {
      const opened = await openEnrollmentSession(pool, cfg, {
        courseId,
        lecturerId: actor(req),
        studentId,
        idMethod: body.data.idMethod,
      });
      return reply.code(201).send(opened);
    } catch (err) {
      return handle(reply, err);
    }
  });

  // --- Pilot metrics for the course's lecturers: totals only, never any names or sub-reasons -------
  app.get('/courses/:courseId/face-metrics', COURSE_ROUTE, async (req, reply) => {
    const { courseId } = req.params as { courseId: string };
    if (!(await faceEnabled(courseId))) return notFound(reply);
    return pilotMetrics(pool, courseId);
  });
}

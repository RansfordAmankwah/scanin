import type { FastifyInstance, FastifyReply } from 'fastify';
import type pg from 'pg';
import { z } from 'zod';
import { hit } from '../auth/rateLimit.js';
import { LECTURER_ONLY, STUDENT_ONLY } from '../authz/index.js';
import type { Config } from '../config.js';
import { INVALIDATION_CATEGORIES } from '../reviews/corrections.js';
import { ReviewError } from '../reviews/errors.js';
import { listDisputes, resolveDispute, studentRespond } from './disputes.js';
import {
  addReconciliationNote,
  getReconciliation,
  recordHeadcount,
  type ReconciliationSettings,
} from './reconciliation.js';
import {
  generateSpotCheck,
  listSpotChecks,
  METHODS,
  recordSpotCheckResult,
  type SpotCheckSettings,
} from './spotChecks.js';

const COURSE_ROUTE = { config: { authz: { roles: LECTURER_ONLY, course: 'courseId' } } };
const STUDENT_ROUTE = { config: { authz: { roles: STUDENT_ONLY } } };

const HOUR = 60 * 60;

const text = (min: number, max: number) => z.string().trim().min(min).max(max);

const HeadcountBody = z.object({
  headcount: z.number(),
  explanation: z.string().trim().max(1000).optional(),
});
const NoteBody = z.object({ note: text(10, 2000) });
const GenerateBody = z.object({
  size: z.number().optional(),
  requestId: z.string().uuid().optional(),
});
const ResultBody = z.object({
  requestId: z.string().uuid(),
  outcome: z.enum(['VERIFIED', 'NOT_PRESENT', 'COULD_NOT_VERIFY']),
  method: z.enum(METHODS).optional(),
  explanation: z.string().trim().max(2000).optional(),
});
const ResolveBody = z.object({
  resolution: z.enum(['UPHOLD', 'INVALIDATE']),
  category: z.enum(INVALIDATION_CATEGORIES).optional(),
  explanation: text(10, 2000),
});
const RespondBody = z.object({ note: text(1, 1000) });

function handle(reply: FastifyReply, err: unknown) {
  if (err instanceof ReviewError) {
    return reply
      .code(err.status)
      .send({ error: { code: err.code, message: err.message, ...err.extra } });
  }
  throw err;
}

const invalid = (
  reply: FastifyReply,
  code = 'INVALID_REQUEST',
  message = 'Check the form and try again.',
) => reply.code(400).send({ error: { code, message } });

export function registerAntiProxyRoutes(
  app: FastifyInstance,
  deps: { pool: pg.Pool; config: Config },
): void {
  const { pool, config } = deps;
  const actor = (req: { auth: { userId: string } | null }) => req.auth?.userId as string;

  const reconciliation: ReconciliationSettings = {
    tolerancePercent: config.HEADCOUNT_TOLERANCE_PERCENT,
    toleranceMin: config.HEADCOUNT_TOLERANCE_MIN,
    headcountMax: config.HEADCOUNT_MAX,
    staleMinutes: config.HEADCOUNT_STALE_MINUTES,
  };
  const spotChecks: SpotCheckSettings = {
    defaultSize: config.SPOT_CHECK_DEFAULT_SIZE,
    maxSize: config.SPOT_CHECK_MAX_SIZE,
    historySessions: config.SPOT_CHECK_HISTORY_SESSIONS,
  };

  /** Replies 429 and returns true when `key` has had more than `max` writes in the window. */
  async function limited(reply: FastifyReply, key: string, max: number, windowSeconds = HOUR) {
    const state = await hit(pool, key, windowSeconds);
    if (state.count <= max) return false;
    void reply.header('Retry-After', String(state.retryAfterSeconds));
    void reply.code(429).send({
      error: {
        code: 'RATE_LIMITED',
        message: 'Too many requests. Wait a moment and try again.',
        retryAfterSeconds: state.retryAfterSeconds,
      },
    });
    return true;
  }

  const base = '/courses/:courseId/sessions/:sessionId';
  type P = { courseId: string; sessionId: string };

  // --- Headcount and reconciliation --------------------------------------------------------

  app.get(`${base}/reconciliation`, COURSE_ROUTE, async (req, reply) => {
    const { courseId, sessionId } = req.params as P;
    try {
      return await getReconciliation(pool, courseId, sessionId, reconciliation);
    } catch (err) {
      return handle(reply, err);
    }
  });

  app.put(`${base}/headcount`, COURSE_ROUTE, async (req, reply) => {
    const { courseId, sessionId } = req.params as P;
    const body = HeadcountBody.safeParse(req.body);
    if (!body.success) {
      return invalid(
        reply,
        'INVALID_HEADCOUNT',
        `Enter a whole number from 0 to ${config.HEADCOUNT_MAX}.`,
      );
    }
    if (await limited(reply, `headcount:${actor(req)}`, 120)) return;
    try {
      return await recordHeadcount(
        pool,
        {
          courseId,
          sessionId,
          actorId: actor(req),
          headcount: body.data.headcount,
          explanation: body.data.explanation ?? null,
        },
        reconciliation,
      );
    } catch (err) {
      return handle(reply, err);
    }
  });

  app.post(`${base}/reconciliation/notes`, COURSE_ROUTE, async (req, reply) => {
    const { courseId, sessionId } = req.params as P;
    const body = NoteBody.safeParse(req.body);
    if (!body.success)
      return invalid(reply, 'INVALID_REQUEST', 'Write a note of at least 10 characters.');
    if (await limited(reply, `recon-note:${actor(req)}`, 120)) return;
    try {
      return reply
        .code(201)
        .send(
          await addReconciliationNote(
            pool,
            { courseId, sessionId, actorId: actor(req), note: body.data.note },
            reconciliation,
          ),
        );
    } catch (err) {
      return handle(reply, err);
    }
  });

  // --- Spot checks -------------------------------------------------------------------------

  app.get(`${base}/spot-checks`, COURSE_ROUTE, async (req, reply) => {
    const { courseId, sessionId } = req.params as P;
    try {
      return await listSpotChecks(pool, courseId, sessionId, spotChecks);
    } catch (err) {
      return handle(reply, err);
    }
  });

  app.post(`${base}/spot-checks`, COURSE_ROUTE, async (req, reply) => {
    const { courseId, sessionId } = req.params as P;
    const body = GenerateBody.safeParse(req.body ?? {});
    if (!body.success)
      return invalid(
        reply,
        'INVALID_SAMPLE_SIZE',
        `Choose a sample of 1 to ${config.SPOT_CHECK_MAX_SIZE} students.`,
      );
    if (await limited(reply, `spot-generate:${actor(req)}`, 60)) return;
    try {
      return reply.code(201).send(
        await generateSpotCheck(
          pool,
          {
            courseId,
            sessionId,
            actorId: actor(req),
            ...(body.data.size === undefined ? {} : { size: body.data.size }),
            ...(body.data.requestId ? { requestId: body.data.requestId } : {}),
          },
          spotChecks,
        ),
      );
    } catch (err) {
      return handle(reply, err);
    }
  });

  app.post(`${base}/spot-checks/items/:itemId/result`, COURSE_ROUTE, async (req, reply) => {
    const { courseId, sessionId, itemId } = req.params as P & { itemId: string };
    const body = ResultBody.safeParse(req.body);
    if (!body.success) {
      return invalid(
        reply,
        'INVALID_REQUEST',
        'Choose an outcome, and say how you verified the student if you verified them.',
      );
    }
    if (await limited(reply, `spot-result:${actor(req)}`, 600)) return;
    try {
      return await recordSpotCheckResult(
        pool,
        {
          courseId,
          sessionId,
          itemId,
          actorId: actor(req),
          requestId: body.data.requestId,
          outcome: body.data.outcome,
          method: body.data.method ?? null,
          explanation: body.data.explanation ?? null,
        },
        spotChecks,
      );
    } catch (err) {
      return handle(reply, err);
    }
  });

  // --- Disputes ----------------------------------------------------------------------------

  app.get(`${base}/disputes`, COURSE_ROUTE, async (req, reply) => {
    const { courseId, sessionId } = req.params as P;
    try {
      return await listDisputes(pool, courseId, sessionId);
    } catch (err) {
      return handle(reply, err);
    }
  });

  app.post(`${base}/disputes/:disputeId/resolve`, COURSE_ROUTE, async (req, reply) => {
    const { courseId, sessionId, disputeId } = req.params as P & { disputeId: string };
    const body = ResolveBody.safeParse(req.body);
    if (!body.success) {
      return invalid(
        reply,
        'INVALID_REQUEST',
        'Choose a resolution and write a reason of at least 10 characters.',
      );
    }
    if (await limited(reply, `dispute-resolve:${actor(req)}`, 300)) return;
    try {
      return await resolveDispute(pool, {
        courseId,
        sessionId,
        disputeId,
        actorId: actor(req),
        resolution: body.data.resolution,
        ...(body.data.category ? { category: body.data.category } : {}),
        explanation: body.data.explanation,
      });
    } catch (err) {
      return handle(reply, err);
    }
  });

  // --- Student: reply to a review of their own record ----------------------------------------

  app.post('/me/disputes/:disputeId/response', STUDENT_ROUTE, async (req, reply) => {
    const { disputeId } = req.params as { disputeId: string };
    const body = RespondBody.safeParse(req.body);
    if (!body.success)
      return invalid(reply, 'INVALID_REQUEST', 'Write your reply (up to 1000 characters).');
    if (await limited(reply, `dispute-reply:${actor(req)}`, 30)) return;
    try {
      return reply
        .code(201)
        .send(
          await studentRespond(pool, { studentId: actor(req), disputeId, note: body.data.note }),
        );
    } catch (err) {
      return handle(reply, err);
    }
  });
}

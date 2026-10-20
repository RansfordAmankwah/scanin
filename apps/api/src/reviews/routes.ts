import type { FastifyInstance, FastifyReply } from 'fastify';
import type pg from 'pg';
import { z } from 'zod';
import { LECTURER_ONLY } from '../authz/index.js';
import {
  attendanceHistory,
  INVALIDATION_CATEGORIES,
  invalidateAttendance,
  markPresentManually,
  restoreAttendance,
} from './corrections.js';
import { notFound, ReviewError, UUID } from './errors.js';
import { flagHistory, raiseFlag, transitionFlag } from './flags.js';
import { addToClass, decideLink, linkHistory, removeFromClass, reviewQueue } from './links.js';

const COURSE_ROUTE = { config: { authz: { roles: LECTURER_ONLY, course: 'courseId' } } };

/** Lecturers' written explanations: required, and long enough to mean something. */
const explanation = z.string().trim().min(10).max(2000);

const DecisionBody = z.object({
  decision: z.enum(['CONFIRM', 'KEEP_PROVISIONAL', 'REJECT', 'MARK_REVIEW_REQUIRED']),
  basis: z.enum(['LECTURER_IDENTITY_CONFIRMED', 'LECTURER_ENROLLMENT_CONFIRMED']).optional(),
  entryId: z.string().uuid().optional(),
  reviewKind: z.enum(['IDENTITY', 'ENROLLMENT']).optional(),
  flagId: z.string().uuid().optional(),
  explanation,
});
const RaiseBody = z.object({
  kind: z.enum(['PROXY_SUSPECTED', 'CONFLICTING_STUDENT_ID', 'AMBIGUOUS_ROSTER_MATCH']),
  attendanceId: z.string().uuid().optional(),
  linkId: z.string().uuid().optional(),
  sessionId: z.string().uuid().optional(),
  note: explanation,
});
const TransitionBody = z.object({
  to: z.enum(['UNDER_REVIEW', 'DISMISSED', 'SUBSTANTIATED']),
  note: z.string().trim().max(2000).default(''),
});
const InvalidateBody = z.object({ category: z.enum(INVALIDATION_CATEGORIES), explanation });
const RestoreBody = z.object({ explanation });
const ManualBody = z.object({ studentId: z.string().trim().min(1).max(64), explanation });

function handle(reply: FastifyReply, err: unknown) {
  if (err instanceof ReviewError) {
    return reply
      .code(err.status)
      .send({ error: { code: err.code, message: err.message, ...err.extra } });
  }
  throw err;
}

const invalid = (reply: FastifyReply, message = 'Check the form and try again.') =>
  reply.code(400).send({ error: { code: 'INVALID_REQUEST', message } });

export function registerReviewRoutes(app: FastifyInstance, deps: { pool: pg.Pool }): void {
  const { pool } = deps;
  const actor = (req: { auth: { userId: string } | null }) => req.auth?.userId as string;

  // --- Class-list matches -------------------------------------------------------------------

  app.get('/courses/:courseId/review-queue', COURSE_ROUTE, async (req) => {
    const { courseId } = req.params as { courseId: string };
    return reviewQueue(pool, courseId);
  });

  app.post('/courses/:courseId/links/:linkId/decision', COURSE_ROUTE, async (req, reply) => {
    const { courseId, linkId } = req.params as { courseId: string; linkId: string };
    if (!UUID.test(linkId)) return handle(reply, notFound());
    const body = DecisionBody.safeParse(req.body);
    if (!body.success)
      return invalid(reply, 'A decision needs a written explanation of at least 10 characters.');
    try {
      return await decideLink(pool, { courseId, linkId, actorId: actor(req), ...body.data });
    } catch (err) {
      return handle(reply, err);
    }
  });

  // One-tap "Not on class list" decisions: add the student to the roster, or remove them.
  app.post('/courses/:courseId/links/:linkId/add-to-class', COURSE_ROUTE, async (req, reply) => {
    const { courseId, linkId } = req.params as { courseId: string; linkId: string };
    try {
      return await addToClass(pool, { courseId, linkId, actorId: actor(req) });
    } catch (err) {
      return handle(reply, err);
    }
  });

  app.post(
    '/courses/:courseId/links/:linkId/remove-from-class',
    COURSE_ROUTE,
    async (req, reply) => {
      const { courseId, linkId } = req.params as { courseId: string; linkId: string };
      try {
        return await removeFromClass(pool, { courseId, linkId, actorId: actor(req) });
      } catch (err) {
        return handle(reply, err);
      }
    },
  );

  app.get('/courses/:courseId/links/:linkId/history', COURSE_ROUTE, async (req, reply) => {
    const { courseId, linkId } = req.params as { courseId: string; linkId: string };
    try {
      return await linkHistory(pool, courseId, linkId);
    } catch (err) {
      return handle(reply, err);
    }
  });

  // --- Investigation flags --------------------------------------------------------------------

  app.post('/courses/:courseId/flags', COURSE_ROUTE, async (req, reply) => {
    const { courseId } = req.params as { courseId: string };
    const body = RaiseBody.safeParse(req.body);
    if (!body.success) return invalid(reply, 'Describe the concern in at least 10 characters.');
    try {
      return reply
        .code(201)
        .send(await raiseFlag(pool, { courseId, actorId: actor(req), ...body.data }));
    } catch (err) {
      return handle(reply, err);
    }
  });

  app.post('/courses/:courseId/flags/:flagId/transition', COURSE_ROUTE, async (req, reply) => {
    const { courseId, flagId } = req.params as { courseId: string; flagId: string };
    const body = TransitionBody.safeParse(req.body);
    if (!body.success) return invalid(reply);
    // Resolving or reopening needs a written note; starting a review does not.
    if (body.data.to !== 'UNDER_REVIEW' && body.data.note.length < 10) {
      return invalid(reply, 'Resolving a flag needs a written note of at least 10 characters.');
    }
    try {
      return await transitionFlag(pool, { courseId, flagId, actorId: actor(req), ...body.data });
    } catch (err) {
      return handle(reply, err);
    }
  });

  app.get('/courses/:courseId/flags/:flagId/history', COURSE_ROUTE, async (req, reply) => {
    const { courseId, flagId } = req.params as { courseId: string; flagId: string };
    try {
      return await flagHistory(pool, courseId, flagId);
    } catch (err) {
      return handle(reply, err);
    }
  });

  // --- Attendance corrections -----------------------------------------------------------------

  const base = '/courses/:courseId/sessions/:sessionId/attendance';

  app.post(`${base}/manual`, COURSE_ROUTE, async (req, reply) => {
    const { courseId, sessionId } = req.params as { courseId: string; sessionId: string };
    const body = ManualBody.safeParse(req.body);
    if (!body.success)
      return invalid(reply, 'Enter the student ID and a written reason of at least 10 characters.');
    try {
      return reply.code(201).send(
        await markPresentManually(pool, {
          courseId,
          sessionId,
          actorId: actor(req),
          studentIdText: body.data.studentId,
          explanation: body.data.explanation,
        }),
      );
    } catch (err) {
      return handle(reply, err);
    }
  });

  app.post(`${base}/:attendanceId/invalidate`, COURSE_ROUTE, async (req, reply) => {
    const { courseId, sessionId, attendanceId } = req.params as {
      courseId: string;
      sessionId: string;
      attendanceId: string;
    };
    const body = InvalidateBody.safeParse(req.body);
    if (!body.success)
      return invalid(reply, 'Choose a reason and write an explanation of at least 10 characters.');
    try {
      return await invalidateAttendance(pool, {
        courseId,
        sessionId,
        attendanceId,
        actorId: actor(req),
        ...body.data,
      });
    } catch (err) {
      return handle(reply, err);
    }
  });

  app.post(`${base}/:attendanceId/restore`, COURSE_ROUTE, async (req, reply) => {
    const { courseId, sessionId, attendanceId } = req.params as {
      courseId: string;
      sessionId: string;
      attendanceId: string;
    };
    const body = RestoreBody.safeParse(req.body);
    if (!body.success)
      return invalid(reply, 'Restoring needs a written explanation of at least 10 characters.');
    try {
      return await restoreAttendance(pool, {
        courseId,
        sessionId,
        attendanceId,
        actorId: actor(req),
        ...body.data,
      });
    } catch (err) {
      return handle(reply, err);
    }
  });

  app.get(`${base}/:attendanceId/history`, COURSE_ROUTE, async (req, reply) => {
    const { courseId, sessionId, attendanceId } = req.params as {
      courseId: string;
      sessionId: string;
      attendanceId: string;
    };
    try {
      return await attendanceHistory(pool, courseId, sessionId, attendanceId);
    } catch (err) {
      return handle(reply, err);
    }
  });
}

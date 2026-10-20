import type { FastifyInstance, FastifyReply } from 'fastify';
import type pg from 'pg';
import { z } from 'zod';
import { LECTURER_ONLY, STUDENT_ONLY } from '../authz/index.js';
import { ReviewError } from '../reviews/errors.js';
import {
  courseAttendanceMatrix,
  courseAttendanceSummary,
  courseStudentHistory,
  lecturerOverview,
  studentCourseHistory,
  studentCourses,
} from './history.js';
import { isScanOutcome, scanHistory, sessionRoster } from './service.js';

const COURSE_ROUTE = { config: { authz: { roles: LECTURER_ONLY, course: 'courseId' } } };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const notFound = (reply: FastifyReply) =>
  reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Not found.' } });

const ScanQuery = z.object({
  student: z.string().trim().max(100).optional(),
  outcome: z.string().max(40).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  before: z.string().max(200).optional(),
});

function decodeCursor(
  raw: string | undefined,
): { receivedAt: string; id: string } | null | undefined {
  if (raw === undefined) return undefined;
  try {
    const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as {
      receivedAt?: unknown;
      id?: unknown;
    };
    if (
      typeof parsed.receivedAt === 'string' &&
      /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(parsed.receivedAt) &&
      typeof parsed.id === 'string' &&
      UUID.test(parsed.id)
    ) {
      return { receivedAt: parsed.receivedAt, id: parsed.id };
    }
  } catch {
    // fall through
  }
  return null;
}

export function registerAttendanceRoutes(app: FastifyInstance, deps: { pool: pg.Pool }): void {
  const { pool } = deps;

  /** Who attended, in what state. Carries no scan times (see /scans). */
  app.get('/courses/:courseId/sessions/:sessionId/attendance', COURSE_ROUTE, async (req, reply) => {
    const { courseId, sessionId } = req.params as { courseId: string; sessionId: string };
    if (!UUID.test(sessionId)) return notFound(reply);
    const exists = await pool.query(
      'SELECT 1 FROM class_sessions WHERE id = $1 AND course_id = $2',
      [sessionId, courseId],
    );
    if (exists.rowCount === 0) return notFound(reply);
    return sessionRoster(pool, courseId, sessionId);
  });

  /** Searchable scan history, with times. Assigned lecturers only. */
  app.get('/courses/:courseId/sessions/:sessionId/scans', COURSE_ROUTE, async (req, reply) => {
    const { courseId, sessionId } = req.params as { courseId: string; sessionId: string };
    if (!UUID.test(sessionId)) return notFound(reply);
    const q = ScanQuery.safeParse(req.query);
    if (!q.success || (q.data.outcome && !isScanOutcome(q.data.outcome))) {
      return reply
        .code(400)
        .send({ error: { code: 'INVALID_REQUEST', message: 'Check the filters and try again.' } });
    }
    const before = decodeCursor(q.data.before);
    if (before === null) {
      return reply
        .code(400)
        .send({ error: { code: 'INVALID_REQUEST', message: 'Invalid page cursor.' } });
    }
    const exists = await pool.query(
      'SELECT 1 FROM class_sessions WHERE id = $1 AND course_id = $2',
      [sessionId, courseId],
    );
    if (exists.rowCount === 0) return notFound(reply);

    const page = await scanHistory(pool, sessionId, {
      student: q.data.student || undefined,
      outcome: q.data.outcome,
      limit: q.data.limit,
      before,
    });
    return {
      scans: page.scans,
      nextCursor: page.nextBefore
        ? Buffer.from(JSON.stringify(page.nextBefore)).toString('base64url')
        : null,
    };
  });

  // --- Course-based history (see docs/COURSE_ATTENDANCE.md) ---------------------------------------

  const guard = async <T>(reply: FastifyReply, run: () => Promise<T>) => {
    try {
      return await run();
    } catch (err) {
      if (err instanceof ReviewError) {
        return reply.code(err.status).send({ error: { code: err.code, message: err.message } });
      }
      throw err;
    }
  };

  /** Every course the signed-in student belongs to. The student is always the signed-in account. */
  app.get('/me/courses', { config: { authz: { roles: STUDENT_ONLY } } }, async (req) =>
    studentCourses(pool, req.auth?.userId as string),
  );

  /** One course's history for the signed-in student; a course they are not in looks like "not found". */
  app.get(
    '/me/courses/:courseId',
    { config: { authz: { roles: STUDENT_ONLY } } },
    async (req, reply) => {
      const { courseId } = req.params as { courseId: string };
      return guard(reply, () => studentCourseHistory(pool, req.auth?.userId as string, courseId));
    },
  );

  /** The lecturer's home: each assigned course, what is running now, and what needs attention. */
  app.get('/courses/overview', { config: { authz: { roles: LECTURER_ONLY } } }, async (req) =>
    lecturerOverview(pool, req.auth?.userId as string),
  );

  /** Per-session totals and each student's cumulative attendance for one course. */
  app.get('/courses/:courseId/attendance-summary', COURSE_ROUTE, async (req) => {
    const { courseId } = req.params as { courseId: string };
    return courseAttendanceSummary(pool, courseId);
  });

  /** One grid for the whole course: students x sessions, Present/Absent in each cell. */
  app.get('/courses/:courseId/attendance-matrix', COURSE_ROUTE, async (req, reply) => {
    const { courseId } = req.params as { courseId: string };
    return guard(reply, () => courseAttendanceMatrix(pool, courseId));
  });

  /** One student's attendance across a course's sessions, as the lecturer sees it. */
  app.get('/courses/:courseId/students/:linkId/attendance', COURSE_ROUTE, async (req, reply) => {
    const { courseId, linkId } = req.params as { courseId: string; linkId: string };
    return guard(reply, () => courseStudentHistory(pool, courseId, linkId));
  });
}

import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { z } from 'zod';
import { courseRetainUntil, writeAudit } from '../audit.js';
import { hit } from '../auth/rateLimit.js';
import { LECTURER_ONLY } from '../authz/index.js';
import { isUniqueViolation, withTransaction } from '../db/pool.js';

interface CourseRow {
  id: string;
  code: string;
  title: string;
  term_id: string;
  term_name: string;
  starts_on: string;
  ends_on: string;
  face_verification_enabled: boolean;
}

function present(row: CourseRow) {
  return {
    id: row.id,
    code: row.code,
    title: row.title,
    term: { id: row.term_id, name: row.term_name, startsOn: row.starts_on, endsOn: row.ends_on },
    faceVerificationEnabled: row.face_verification_enabled,
  };
}

const COURSE_SELECT = `
  SELECT c.id, c.code, c.title, c.face_verification_enabled, t.id AS term_id, t.name AS term_name,
         to_char(t.starts_on, 'YYYY-MM-DD') AS starts_on, to_char(t.ends_on, 'YYYY-MM-DD') AS ends_on
    FROM courses c
    JOIN terms t ON t.id = c.term_id
    JOIN lecturer_courses lc ON lc.course_id = c.id`;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

const CreateCourseBody = z
  .object({
    code: z.string().max(64),
    title: z.string().max(400),
    termId: z.string().uuid().optional(),
    newTerm: z
      .object({
        name: z.string().max(200),
        startsOn: z.string().regex(ISO_DATE),
        endsOn: z.string().regex(ISO_DATE),
      })
      .optional(),
  })
  .refine((b) => (b.termId === undefined) !== (b.newTerm === undefined), {
    message: 'Choose an existing term or describe a new one, not both.',
  });

/** Reasons the database functions refuse a request (SQLSTATE SC001; the message is the reason). */
const REFUSALS: Record<string, { status: number; message: string }> = {
  INVALID_TERM: {
    status: 400,
    message:
      'The term needs a name, an end date after its start date, a length of at most about a year, and an end date within the next two years.',
  },
  INVALID_COURSE: {
    status: 400,
    message: 'The course needs a code (up to 32 characters) and a title (up to 200 characters).',
  },
  TERM_NOT_FOUND: { status: 404, message: 'That term does not exist.' },
  NOT_A_LECTURER: { status: 403, message: 'Only lecturers can create courses.' },
};

const COURSES_PER_HOUR = 20;

export function registerCourseRoutes(app: FastifyInstance, deps: { pool: pg.Pool }): void {
  const { pool } = deps;

  /** The courses the signed-in lecturer is currently assigned to, and no others. */
  app.get('/courses', { config: { authz: { roles: LECTURER_ONLY } } }, async (req) => {
    const { rows } = await pool.query<CourseRow>(
      `${COURSE_SELECT}
        WHERE lc.lecturer_id = $1 AND lc.ended_at IS NULL
        ORDER BY t.starts_on DESC, c.code`,
      [req.auth?.userId],
    );
    return { courses: rows.map(present) };
  });

  /** Terms this lecturer can put a course in: the operator's shared terms and their own. */
  app.get('/terms', { config: { authz: { roles: LECTURER_ONLY } } }, async (req) => {
    const { rows } = await pool.query<{
      id: string;
      name: string;
      starts_on: string;
      ends_on: string;
    }>(
      `SELECT id, name, to_char(starts_on, 'YYYY-MM-DD') AS starts_on,
              to_char(ends_on, 'YYYY-MM-DD') AS ends_on
         FROM terms WHERE created_by IS NULL OR created_by = $1
        ORDER BY starts_on DESC, name`,
      [req.auth?.userId],
    );
    return {
      terms: rows.map((r) => ({
        id: r.id,
        name: r.name,
        startsOn: r.starts_on,
        endsOn: r.ends_on,
      })),
    };
  });

  /**
   * Creates a course (and, if asked, a new term of the lecturer's own) and assigns the lecturer to
   * it. The database functions do the writing; the application role cannot insert these rows itself.
   */
  app.post('/courses', { config: { authz: { roles: LECTURER_ONLY } } }, async (req, reply) => {
    const userId = req.auth?.userId as string;
    const fail = (status: number, code: string, message: string, extra?: object) =>
      reply.code(status).send({ error: { code, message, ...extra } });

    const limit = await hit(pool, `course-create:${userId}`, 60 * 60);
    if (limit.count > COURSES_PER_HOUR) {
      return fail(429, 'RATE_LIMITED', 'Too many courses created. Try again later.', {
        retryAfterSeconds: limit.retryAfterSeconds,
      });
    }
    const body = CreateCourseBody.safeParse(req.body);
    if (!body.success) return fail(400, 'INVALID_REQUEST', 'Check the form and try again.');
    const { code, title, termId, newTerm } = body.data;

    try {
      const courseId = await withTransaction(pool, async (c) => {
        let term = termId;
        if (newTerm) {
          const made = await c.query<{ id: string }>(
            'SELECT create_term_for_lecturer($1, $2, $3::date, $4::date) AS id',
            [userId, newTerm.name, newTerm.startsOn, newTerm.endsOn],
          );
          term = made.rows[0]?.id;
          await writeAudit(c, {
            class: 'SECURITY',
            actorType: 'LECTURER',
            actorUserId: userId,
            action: 'TERM_CREATED',
            entityType: 'term',
            entityId: term as string,
            summary: { name: newTerm.name.trim() },
          });
        }
        const made = await c.query<{ id: string }>(
          'SELECT create_course_for_lecturer($1, $2, $3, $4) AS id',
          [userId, term, code, title],
        );
        const id = made.rows[0]?.id as string;
        await writeAudit(c, {
          class: 'DOMAIN',
          actorType: 'LECTURER',
          actorUserId: userId,
          action: 'COURSE_CREATED',
          courseId: id,
          entityType: 'course',
          entityId: id,
          retainUntil: await courseRetainUntil(c, id),
          summary: { code: code.trim() },
        });
        return id;
      });
      const { rows } = await pool.query<CourseRow>(
        `${COURSE_SELECT} WHERE c.id = $1 AND lc.lecturer_id = $2`,
        [courseId, userId],
      );
      return reply.code(201).send({ course: present(rows[0] as CourseRow) });
    } catch (err) {
      const e = err as { code?: string; message?: string };
      if (e.code === '22008' || e.code === '22007') {
        // An impossible calendar date such as 2026-02-31.
        return fail(400, 'INVALID_TERM', (REFUSALS.INVALID_TERM as { message: string }).message);
      }
      if (e.code === 'SC001' && e.message && REFUSALS[e.message]) {
        const r = REFUSALS[e.message] as { status: number; message: string };
        return fail(r.status, e.message, r.message);
      }
      if (isUniqueViolation(err, 'terms_owned_name_key')) {
        return fail(
          409,
          'TERM_EXISTS',
          'You already have a term with that name. Pick it from the list.',
        );
      }
      if (isUniqueViolation(err, 'courses_term_code_key')) {
        return fail(409, 'COURSE_EXISTS', 'A course with that code already exists in that term.');
      }
      throw err;
    }
  });

  // Access to :courseId is checked centrally (404 unless the lecturer is assigned).
  app.get(
    '/courses/:courseId',
    { config: { authz: { roles: LECTURER_ONLY, course: 'courseId' } } },
    async (req, reply) => {
      const { courseId } = req.params as { courseId: string };
      const { rows } = await pool.query<CourseRow>(
        `${COURSE_SELECT} WHERE c.id = $1 AND lc.lecturer_id = $2 AND lc.ended_at IS NULL`,
        [courseId, req.auth?.userId],
      );
      const row = rows[0];
      if (!row)
        return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Not found.' } });
      return { course: present(row) };
    },
  );
}

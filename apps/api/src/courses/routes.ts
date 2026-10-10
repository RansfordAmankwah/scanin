import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { LECTURER_ONLY } from '../authz/index.js';

interface CourseRow {
  id: string;
  code: string;
  title: string;
  term_id: string;
  term_name: string;
  starts_on: string;
  ends_on: string;
}

function present(row: CourseRow) {
  return {
    id: row.id,
    code: row.code,
    title: row.title,
    term: { id: row.term_id, name: row.term_name, startsOn: row.starts_on, endsOn: row.ends_on },
  };
}

const COURSE_SELECT = `
  SELECT c.id, c.code, c.title, t.id AS term_id, t.name AS term_name,
         to_char(t.starts_on, 'YYYY-MM-DD') AS starts_on, to_char(t.ends_on, 'YYYY-MM-DD') AS ends_on
    FROM courses c
    JOIN terms t ON t.id = c.term_id
    JOIN lecturer_courses lc ON lc.course_id = c.id`;

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

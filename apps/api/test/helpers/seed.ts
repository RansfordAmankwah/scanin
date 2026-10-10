import { randomBytes } from 'node:crypto';
import type pg from 'pg';

type Queryable = pg.Pool | pg.PoolClient;

const rand = (): string => randomBytes(4).toString('hex');

/** Runs `fn` in a transaction (needed wherever deferred foreign keys tie rows together). */
export async function tx<T>(pool: pg.Pool, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

async function one<T extends string>(db: Queryable, sql: string, params: unknown[]): Promise<T> {
  const { rows } = await db.query<{ id: T }>(sql, params);
  const row = rows[0];
  if (!row) throw new Error('seed insert returned no row');
  return row.id;
}

export function createTerm(db: Queryable): Promise<string> {
  return one(
    db,
    `INSERT INTO terms (name, starts_on, ends_on) VALUES ($1, '2026-09-01', '2026-12-20') RETURNING id`,
    [`term-${rand()}`],
  );
}

export function createCourse(db: Queryable, termId: string): Promise<string> {
  return one(
    db,
    `INSERT INTO courses (term_id, code, title) VALUES ($1, $2, 'Test course') RETURNING id`,
    [termId, `C-${rand()}`],
  );
}

export function createLecturer(db: Queryable): Promise<string> {
  return one(
    db,
    `INSERT INTO users (role, email, full_name, password_hash)
     VALUES ('LECTURER', $1, 'Dr Test', 'x') RETURNING id`,
    [`lec-${rand()}@example.test`],
  );
}

export function createStudent(db: Queryable, studentId = `S${rand()}`): Promise<string> {
  return one(
    db,
    `INSERT INTO users (role, email, full_name, student_id_norm, student_id_display, password_hash)
     VALUES ('STUDENT', $1, 'Stu Dent', $2, $2, 'x') RETURNING id`,
    [`stu-${rand()}@example.test`, studentId],
  );
}

export interface LinkOptions {
  state?: 'PROVISIONAL' | 'REVIEW_REQUIRED';
}

/** A course-student association plus its first (system) review, as one atomic unit. */
export async function createLink(
  pool: pg.Pool,
  courseId: string,
  studentId: string,
  opts: LinkOptions = {},
): Promise<string> {
  const state = opts.state ?? 'PROVISIONAL';
  return tx(pool, async (c) => {
    const id = await one<string>(
      c,
      `INSERT INTO roster_links (course_id, student_id, state) VALUES ($1, $2, $3) RETURNING id`,
      [courseId, studentId, state],
    );
    await c.query(
      `INSERT INTO identity_reviews (link_id, review_no, review_kind, decision, from_state, to_state)
       VALUES ($1, 1, 'SYSTEM_MATCH', 'SYSTEM_MATCH', NULL, $2)`,
      [id, state],
    );
    return id;
  });
}

export type SessionStateName = 'NOT_STARTED' | 'CHECK_IN_OPEN' | 'CHECK_IN_CLOSED' | 'ENDED';

/** Inserts a session directly in the requested lifecycle state with a valid shape. */
export function createSession(
  db: Queryable,
  courseId: string,
  lecturerId: string,
  state: SessionStateName = 'NOT_STARTED',
): Promise<string> {
  const base = `now() - interval '10 minutes'`;
  switch (state) {
    case 'NOT_STARTED':
      return one(
        db,
        `INSERT INTO class_sessions (course_id, created_by, title, session_date)
         VALUES ($1, $2, 'Lecture', current_date) RETURNING id`,
        [courseId, lecturerId],
      );
    case 'CHECK_IN_OPEN':
      return one(
        db,
        `INSERT INTO class_sessions (course_id, created_by, title, session_date, state,
           started_at, started_by, check_in_deadline)
         VALUES ($1, $2, 'Lecture', current_date, 'CHECK_IN_OPEN',
           ${base}, $2, ${base} + interval '30 minutes') RETURNING id`,
        [courseId, lecturerId],
      );
    case 'CHECK_IN_CLOSED':
      return one(
        db,
        `INSERT INTO class_sessions (course_id, created_by, title, session_date, state,
           started_at, started_by, check_in_deadline, check_in_closed_at, check_in_closed_reason)
         VALUES ($1, $2, 'Lecture', current_date, 'CHECK_IN_CLOSED',
           ${base}, $2, ${base} + interval '5 minutes', ${base} + interval '5 minutes', 'DEADLINE')
         RETURNING id`,
        [courseId, lecturerId],
      );
    case 'ENDED':
      return one(
        db,
        `INSERT INTO class_sessions (course_id, created_by, title, session_date, state,
           started_at, started_by, check_in_deadline, check_in_closed_at, check_in_closed_reason,
           ended_at, ended_by)
         VALUES ($1, $2, 'Lecture', current_date, 'ENDED',
           ${base}, $2, ${base} + interval '30 minutes', ${base} + interval '5 minutes',
           'ENDED_BY_LECTURER', ${base} + interval '5 minutes', $2) RETURNING id`,
        [courseId, lecturerId],
      );
  }
}

export interface Fixture {
  courseId: string;
  lecturerId: string;
  studentId: string;
  linkId: string;
}

/** One term/course with a lecturer, a student, and the student's link. */
export async function createFixture(pool: pg.Pool): Promise<Fixture> {
  const termId = await createTerm(pool);
  const courseId = await createCourse(pool, termId);
  const lecturerId = await createLecturer(pool);
  const studentId = await createStudent(pool);
  const linkId = await createLink(pool, courseId, studentId);
  return { courseId, lecturerId, studentId, linkId };
}

/** Attendance record plus its first revision, atomically. */
export async function createAttendance(
  pool: pg.Pool,
  f: Fixture,
  sessionId: string,
): Promise<string> {
  return tx(pool, async (c) => {
    const id = await one<string>(
      c,
      `INSERT INTO attendance_records (session_id, course_id, student_id, link_id, source)
       VALUES ($1, $2, $3, $4, 'QR_SCAN') RETURNING id`,
      [sessionId, f.courseId, f.studentId, f.linkId],
    );
    await c.query(
      `INSERT INTO attendance_revisions
         (attendance_id, rev_no, change_kind, from_status, to_status, actor_user_id)
       VALUES ($1, 1, 'CREATED_QR', NULL, 'PRESENT', $2)`,
      [id, f.studentId],
    );
    return id;
  });
}

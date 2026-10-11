import type pg from 'pg';
import { courseRetainUntil, writeAudit } from '../audit.js';
import { randomToken } from '../auth/crypto.js';
import { normalizeEmail, normalizeFullName } from '../auth/identifiers.js';
import { hashPassword } from '../auth/password.js';
import { isUniqueViolation, withTransaction } from '../db/pool.js';

/**
 * Provisioning performed by the operator (there is no administrator dashboard). Every command runs
 * in one transaction with its audit event. They are plain functions so tests exercise exactly what
 * the CLI runs.
 */
export class OperatorError extends Error {}

interface Actor {
  /** Free-text label of who ran the command (e.g. the OS user), recorded in the audit summary. */
  operator: string;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export async function createTerm(
  pool: pg.Pool,
  input: Actor & { name: string; startsOn: string; endsOn: string },
): Promise<{ id: string }> {
  if (!ISO_DATE.test(input.startsOn) || !ISO_DATE.test(input.endsOn)) {
    throw new OperatorError('Dates must be YYYY-MM-DD.');
  }
  if (input.endsOn <= input.startsOn) throw new OperatorError('Term must end after it starts.');
  try {
    return await withTransaction(pool, async (c) => {
      const { rows } = await c.query<{ id: string }>(
        `INSERT INTO terms (name, starts_on, ends_on) VALUES ($1, $2, $3) RETURNING id`,
        [input.name.trim(), input.startsOn, input.endsOn],
      );
      const id = rows[0]?.id as string;
      await writeAudit(c, {
        class: 'SECURITY',
        actorType: 'OPERATOR',
        action: 'TERM_CREATED',
        entityType: 'term',
        entityId: id,
        summary: { operator: input.operator, name: input.name.trim() },
      });
      return { id };
    });
  } catch (err) {
    if (isUniqueViolation(err)) throw new OperatorError(`Term "${input.name}" already exists.`);
    throw err;
  }
}

async function termId(c: pg.PoolClient, name: string): Promise<string> {
  const { rows } = await c.query<{ id: string }>(
    'SELECT id FROM terms WHERE name = $1 AND created_by IS NULL',
    [name],
  );
  const id = rows[0]?.id;
  if (!id) throw new OperatorError(`No term named "${name}".`);
  return id;
}

async function courseId(c: pg.PoolClient, term: string, code: string): Promise<string> {
  const { rows } = await c.query<{ id: string }>(
    `SELECT c.id FROM courses c JOIN terms t ON t.id = c.term_id WHERE t.name = $1 AND t.created_by IS NULL AND c.code = $2`,
    [term, code],
  );
  const id = rows[0]?.id;
  if (!id) throw new OperatorError(`No course "${code}" in term "${term}".`);
  return id;
}

async function lecturerId(c: pg.PoolClient, email: string): Promise<string> {
  const { rows } = await c.query<{ id: string }>(
    `SELECT id FROM users WHERE email = $1 AND role = 'LECTURER'`,
    [normalizeEmail(email)],
  );
  const id = rows[0]?.id;
  if (!id) throw new OperatorError(`No lecturer account with e-mail "${email}".`);
  return id;
}

export async function createCourse(
  pool: pg.Pool,
  input: Actor & { term: string; code: string; title: string },
): Promise<{ id: string }> {
  if (!input.code.trim() || !input.title.trim()) {
    throw new OperatorError('Course code and title are required.');
  }
  try {
    return await withTransaction(pool, async (c) => {
      const tid = await termId(c, input.term);
      const { rows } = await c.query<{ id: string }>(
        `INSERT INTO courses (term_id, code, title) VALUES ($1, $2, $3) RETURNING id`,
        [tid, input.code.trim(), input.title.trim()],
      );
      const id = rows[0]?.id as string;
      await writeAudit(c, {
        class: 'DOMAIN',
        actorType: 'OPERATOR',
        action: 'COURSE_CREATED',
        courseId: id,
        entityType: 'course',
        entityId: id,
        retainUntil: await courseRetainUntil(c, id),
        summary: { operator: input.operator, code: input.code.trim() },
      });
      return { id };
    });
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw new OperatorError(`Course "${input.code}" already exists in term "${input.term}".`);
    }
    throw err;
  }
}

/**
 * Creates a lecturer account with a random temporary password, returned once to the operator.
 * The operator vouches for the e-mail address, so it is marked verified. The lecturer is expected
 * to change the password after the first sign-in.
 */
export async function createLecturer(
  pool: pg.Pool,
  input: Actor & { email: string; fullName: string },
): Promise<{ id: string; temporaryPassword: string }> {
  const fullName = normalizeFullName(input.fullName);
  if (!fullName) throw new OperatorError('A full name is required.');
  const email = normalizeEmail(input.email);
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new OperatorError('Invalid e-mail address.');

  const temporaryPassword = randomToken(18);
  const passwordHash = await hashPassword(temporaryPassword);
  try {
    const id = await withTransaction(pool, async (c) => {
      const { rows } = await c.query<{ id: string }>(
        `INSERT INTO users (role, email, email_verified_at, full_name, password_hash)
         VALUES ('LECTURER', $1, clock_timestamp(), $2, $3) RETURNING id`,
        [email, fullName, passwordHash],
      );
      const created = rows[0]?.id as string;
      await writeAudit(c, {
        class: 'SECURITY',
        actorType: 'OPERATOR',
        action: 'LECTURER_CREATED',
        entityType: 'user',
        entityId: created,
        summary: { operator: input.operator },
      });
      return created;
    });
    return { id, temporaryPassword };
  } catch (err) {
    if (isUniqueViolation(err))
      throw new OperatorError(`An account with "${email}" already exists.`);
    throw err;
  }
}

export async function assignLecturer(
  pool: pg.Pool,
  input: Actor & { term: string; courseCode: string; lecturerEmail: string },
): Promise<{ reactivated: boolean }> {
  return withTransaction(pool, async (c) => {
    const cid = await courseId(c, input.term, input.courseCode);
    const lid = await lecturerId(c, input.lecturerEmail);
    const existing = await c.query<{ ended_at: Date | null }>(
      'SELECT ended_at FROM lecturer_courses WHERE course_id = $1 AND lecturer_id = $2',
      [cid, lid],
    );
    const row = existing.rows[0];
    let reactivated = false;
    if (!row) {
      await c.query('INSERT INTO lecturer_courses (course_id, lecturer_id) VALUES ($1, $2)', [
        cid,
        lid,
      ]);
    } else if (row.ended_at === null) {
      throw new OperatorError('That lecturer is already assigned to this course.');
    } else {
      await c.query(
        'UPDATE lecturer_courses SET ended_at = NULL WHERE course_id = $1 AND lecturer_id = $2',
        [cid, lid],
      );
      reactivated = true;
    }
    await writeAudit(c, {
      class: 'DOMAIN',
      actorType: 'OPERATOR',
      action: reactivated ? 'LECTURER_ASSIGNMENT_REACTIVATED' : 'LECTURER_ASSIGNED',
      courseId: cid,
      entityType: 'user',
      entityId: lid,
      retainUntil: await courseRetainUntil(c, cid),
      summary: { operator: input.operator },
    });
    return { reactivated };
  });
}

/** Ends an assignment. The row is kept so past actions stay attributable. */
export async function endAssignment(
  pool: pg.Pool,
  input: Actor & { term: string; courseCode: string; lecturerEmail: string },
): Promise<void> {
  await withTransaction(pool, async (c) => {
    const cid = await courseId(c, input.term, input.courseCode);
    const lid = await lecturerId(c, input.lecturerEmail);
    const result = await c.query(
      `UPDATE lecturer_courses SET ended_at = clock_timestamp()
        WHERE course_id = $1 AND lecturer_id = $2 AND ended_at IS NULL`,
      [cid, lid],
    );
    if (result.rowCount === 0) throw new OperatorError('No active assignment to end.');
    await writeAudit(c, {
      class: 'DOMAIN',
      actorType: 'OPERATOR',
      action: 'LECTURER_ASSIGNMENT_ENDED',
      courseId: cid,
      entityType: 'user',
      entityId: lid,
      retainUntil: await courseRetainUntil(c, cid),
      summary: { operator: input.operator },
    });
  });
}

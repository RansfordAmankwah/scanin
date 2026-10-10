import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createCourse,
  createLecturer,
  createSession,
  createTerm,
  type SessionStateName,
} from '../helpers/seed.js';
import { createMigratedTestDatabase, type MigratedTestDatabase } from '../helpers/testDb.js';

let db: MigratedTestDatabase;
let courseId: string;
let lecturerId: string;

beforeAll(async () => {
  db = await createMigratedTestDatabase();
  courseId = await createCourse(db.pool, await createTerm(db.pool));
  lecturerId = await createLecturer(db.pool);
});

afterAll(async () => {
  await db?.drop();
});

const STATES: SessionStateName[] = ['NOT_STARTED', 'CHECK_IN_OPEN', 'CHECK_IN_CLOSED', 'ENDED'];

/** UPDATE statement that moves a session (currently in `from`) toward `to` with a valid row shape. */
function updateToward(from: SessionStateName, to: SessionStateName): string {
  switch (to) {
    case 'NOT_STARTED':
      return `UPDATE class_sessions SET state = 'NOT_STARTED', started_at = NULL, started_by = NULL,
        check_in_deadline = NULL, check_in_closed_at = NULL, check_in_closed_reason = NULL,
        ended_at = NULL, ended_by = NULL WHERE id = $1`;
    case 'CHECK_IN_OPEN':
      return from === 'NOT_STARTED'
        ? `UPDATE class_sessions SET state = 'CHECK_IN_OPEN', started_at = now(), started_by = $2,
            check_in_deadline = now() + interval '30 minutes' WHERE id = $1`
        : `UPDATE class_sessions SET state = 'CHECK_IN_OPEN', check_in_closed_at = NULL,
            check_in_closed_reason = NULL, ended_at = NULL, ended_by = NULL WHERE id = $1`;
    case 'CHECK_IN_CLOSED':
      return from === 'NOT_STARTED'
        ? `UPDATE class_sessions SET state = 'CHECK_IN_CLOSED', started_at = now() - interval '1 hour',
            started_by = $2, check_in_deadline = now() - interval '30 minutes',
            check_in_closed_at = now() - interval '30 minutes', check_in_closed_reason = 'DEADLINE'
            WHERE id = $1`
        : `UPDATE class_sessions SET state = 'CHECK_IN_CLOSED', check_in_closed_at = check_in_deadline,
            check_in_closed_reason = 'DEADLINE', ended_at = NULL, ended_by = NULL WHERE id = $1`;
    case 'ENDED':
      return from === 'NOT_STARTED'
        ? `UPDATE class_sessions SET state = 'ENDED', started_at = now() - interval '1 hour', started_by = $2,
            check_in_deadline = now() - interval '30 minutes', check_in_closed_at = now(),
            check_in_closed_reason = 'ENDED_BY_LECTURER', ended_at = now(), ended_by = $2 WHERE id = $1`
        : from === 'CHECK_IN_OPEN'
          ? `UPDATE class_sessions SET state = 'ENDED', check_in_closed_at = now(),
              check_in_closed_reason = 'ENDED_BY_LECTURER', ended_at = now(), ended_by = $2 WHERE id = $1`
          : `UPDATE class_sessions SET state = 'ENDED', ended_at = now(), ended_by = $2 WHERE id = $1`;
  }
}

const LEGAL = new Set([
  'NOT_STARTED>CHECK_IN_OPEN',
  'CHECK_IN_OPEN>CHECK_IN_CLOSED',
  'CHECK_IN_OPEN>ENDED',
  'CHECK_IN_CLOSED>ENDED',
  'NOT_STARTED>NOT_STARTED',
  'CHECK_IN_OPEN>CHECK_IN_OPEN',
  'CHECK_IN_CLOSED>CHECK_IN_CLOSED',
]);

describe('SES-02 only legal session transitions succeed (all 16 pairs)', () => {
  for (const actor of ['owner', 'app'] as const) {
    describe(`as ${actor} via direct SQL`, () => {
      for (const from of STATES) {
        for (const to of STATES) {
          const key = `${from}>${to}`;
          const legal = LEGAL.has(key);
          it(`${from} -> ${to} is ${legal ? 'allowed' : 'rejected'}`, async () => {
            const id = await createSession(db.pool, courseId, lecturerId, from);
            const sql = updateToward(from, to);
            const run = (c: { query: (q: string, p: unknown[]) => Promise<unknown> }) =>
              c.query(sql, sql.includes('$2') ? [id, lecturerId] : [id]);
            const attempt = actor === 'owner' ? run(db.pool) : db.asRole(db.appRole, run);
            if (legal) {
              await expect(attempt).resolves.toBeDefined();
              const { rows } = await db.pool.query<{ state: string }>(
                'SELECT state FROM class_sessions WHERE id = $1',
                [id],
              );
              expect(rows[0]?.state).toBe(to);
            } else {
              await expect(attempt).rejects.toMatchObject({ code: '23514' });
            }
          });
        }
      }
    });
  }
});

describe('SES-02 trigger blocks the specific illegal pairs by name', () => {
  it.each([
    ['NOT_STARTED', 'CHECK_IN_CLOSED'],
    ['NOT_STARTED', 'ENDED'],
    ['CHECK_IN_CLOSED', 'CHECK_IN_OPEN'],
    ['ENDED', 'CHECK_IN_OPEN'],
    ['ENDED', 'ENDED'],
  ] as const)('%s -> %s is stopped by the guard trigger, not just a CHECK', async (from, to) => {
    const id = await createSession(db.pool, courseId, lecturerId, from);
    await expect(
      db.pool.query(
        updateToward(from, to),
        updateToward(from, to).includes('$2') ? [id, lecturerId] : [id],
      ),
    ).rejects.toThrow(/class_sessions: /);
  });
});

describe('deadline and window protections', () => {
  it('lets the deadline move forward while open', async () => {
    const id = await createSession(db.pool, courseId, lecturerId, 'CHECK_IN_OPEN');
    await db.pool.query(
      `UPDATE class_sessions SET check_in_deadline = check_in_deadline + interval '10 minutes' WHERE id = $1`,
      [id],
    );
  });

  it('never lets the deadline move backwards', async () => {
    const id = await createSession(db.pool, courseId, lecturerId, 'CHECK_IN_OPEN');
    await expect(
      db.pool.query(
        `UPDATE class_sessions SET check_in_deadline = check_in_deadline - interval '1 minute' WHERE id = $1`,
        [id],
      ),
    ).rejects.toThrow(/can only move forward/);
  });

  it('never lets a closed window be extended or reopened', async () => {
    const id = await createSession(db.pool, courseId, lecturerId, 'CHECK_IN_CLOSED');
    await expect(
      db.pool.query(
        `UPDATE class_sessions SET check_in_deadline = check_in_deadline + interval '10 minutes' WHERE id = $1`,
        [id],
      ),
    ).rejects.toThrow(/cannot be changed or reopened/);
  });

  it('rejects any update to an ENDED session', async () => {
    const id = await createSession(db.pool, courseId, lecturerId, 'ENDED');
    await expect(
      db.pool.query(`UPDATE class_sessions SET title = 'renamed' WHERE id = $1`, [id]),
    ).rejects.toThrow(/terminal/);
  });

  it('keeps started_at fixed once the session has started', async () => {
    const id = await createSession(db.pool, courseId, lecturerId, 'CHECK_IN_OPEN');
    await expect(
      db.pool.query(
        `UPDATE class_sessions SET started_at = started_at - interval '1 minute' WHERE id = $1`,
        [id],
      ),
    ).rejects.toThrow(/started_at cannot change/);
  });

  it('only moves qr_not_before forward (QR invalidation never undone)', async () => {
    const id = await createSession(db.pool, courseId, lecturerId, 'CHECK_IN_OPEN');
    await db.pool.query(`UPDATE class_sessions SET qr_not_before = now() WHERE id = $1`, [id]);
    await expect(
      db.pool.query(
        `UPDATE class_sessions SET qr_not_before = now() - interval '1 hour' WHERE id = $1`,
        [id],
      ),
    ).rejects.toThrow(/qr_not_before/);
  });
});

describe('SES-03 extensions are forward-only and recorded once', () => {
  it('records previous and new deadline, rejects backwards and duplicate-apply', async () => {
    const id = await createSession(db.pool, courseId, lecturerId, 'CHECK_IN_OPEN');
    const { rows } = await db.pool.query<{ check_in_deadline: Date }>(
      'SELECT check_in_deadline FROM class_sessions WHERE id = $1',
      [id],
    );
    const prev = rows[0]!.check_in_deadline;
    const insert = (p: Date, n: Date, reason = 'Class overran') =>
      db.pool.query(
        `INSERT INTO session_extensions (session_id, extended_by, previous_deadline, new_deadline, reason)
         VALUES ($1, $2, $3, $4, $5)`,
        [id, lecturerId, p, n, reason],
      );
    const later = new Date(prev.getTime() + 10 * 60_000);

    await insert(prev, later);
    await expect(insert(prev, later)).rejects.toMatchObject({
      code: '23505',
      constraint: 'session_extensions_once_per_deadline',
    });
    await expect(insert(later, new Date(later.getTime() - 60_000))).rejects.toMatchObject({
      code: '23514',
      constraint: 'session_extensions_forward_only',
    });
    await expect(insert(later, new Date(later.getTime() + 60_000), '   ')).rejects.toMatchObject({
      code: '23514',
    });
  });
});

describe('session shape checks', () => {
  it('rejects an open session without a deadline', async () => {
    await expect(
      db.pool.query(
        `INSERT INTO class_sessions (course_id, created_by, title, session_date, state, started_at, started_by)
         VALUES ($1, $2, 'bad', current_date, 'CHECK_IN_OPEN', now(), $2)`,
        [courseId, lecturerId],
      ),
    ).rejects.toMatchObject({ code: '23514', constraint: 'class_sessions_state_shape' });
  });

  it('rejects a deadline-closed session whose close time is not the deadline', async () => {
    await expect(
      db.pool.query(
        `INSERT INTO class_sessions (course_id, created_by, title, session_date, state, started_at, started_by,
           check_in_deadline, check_in_closed_at, check_in_closed_reason)
         VALUES ($1, $2, 'bad', current_date, 'CHECK_IN_CLOSED', now() - interval '1 hour', $2,
           now() - interval '30 minutes', now() - interval '10 minutes', 'DEADLINE')`,
        [courseId, lecturerId],
      ),
    ).rejects.toMatchObject({ code: '23514', constraint: 'class_sessions_deadline_close_instant' });
  });
});

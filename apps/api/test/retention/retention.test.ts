import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runRetention } from '../../src/retention/service.js';
import { createLecturer } from '../../src/operator/commands.js';
import { createBulkStudents, type BulkStudent } from '../helpers/students.js';
import { createMigratedTestDatabase, type MigratedTestDatabase } from '../helpers/testDb.js';

let db: MigratedTestDatabase;
let lecturerId: string;
let seq = 0;

beforeAll(async () => {
  db = await createMigratedTestDatabase();
  lecturerId = (
    await createLecturer(db.operatorPool, {
      operator: 'test',
      email: 'lec@school.test',
      fullName: 'Dr Lec',
    })
  ).id;
});

afterAll(async () => {
  await db?.drop();
});

const n = async (sql: string, params: unknown[] = []): Promise<number> =>
  (await db.pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM (${sql}) q`, params)).rows[0]!
    .n;

/** Every table that holds data about one course, so "gone" can be checked exhaustively. */
const COURSE_TABLES: Array<[string, string]> = [
  ['courses', 'id = $1'],
  ['lecturer_courses', 'course_id = $1'],
  ['class_sessions', 'course_id = $1'],
  ['session_extensions', 'session_id IN (SELECT id FROM class_sessions WHERE course_id = $1)'],
  ['roster_imports', 'course_id = $1'],
  ['roster_entries', 'course_id = $1'],
  ['roster_links', 'course_id = $1'],
  ['identity_reviews', 'link_id IN (SELECT id FROM roster_links WHERE course_id = $1)'],
  ['attendance_records', 'course_id = $1'],
  [
    'attendance_revisions',
    'attendance_id IN (SELECT id FROM attendance_records WHERE course_id = $1)',
  ],
  ['scan_attempts', 'session_id IN (SELECT id FROM class_sessions WHERE course_id = $1)'],
  ['investigation_flags', 'course_id = $1'],
  [
    'investigation_flag_events',
    'flag_id IN (SELECT id FROM investigation_flags WHERE course_id = $1)',
  ],
  ['export_records', 'course_id = $1'],
  ['audit_events', 'course_id = $1'],
];
/** Rows per table for a course. Scan metadata has its own, shorter 90-day rule, so it is reported separately. */
const rowsFor = async (courseId: string) => {
  const out: Record<string, number> = {};
  for (const [table, where] of COURSE_TABLES)
    out[table] = await n(`SELECT 1 FROM ${table} WHERE ${where}`, [courseId]);
  return out;
};

/** A course with a term ending `endedDaysAgo` days before (today - 1 year) i.e. positive = overdue. */
async function seedCourse(
  overdueDays: number,
): Promise<{ courseId: string; students: BulkStudent[]; sessionId: string }> {
  seq += 1;
  const c = await db.pool.connect();
  try {
    await c.query('BEGIN');
    const term = (
      await c.query<{ id: string }>(
        `INSERT INTO terms (name, starts_on, ends_on)
       VALUES ($1, current_date - interval '2 years', (current_date - interval '1 year' - make_interval(days => $2))::date) RETURNING id`,
        [`term-${seq}-${randomUUID()}`, overdueDays],
      )
    ).rows[0]!.id;
    const courseId = (
      await c.query<{ id: string }>(
        `INSERT INTO courses (term_id, code, title) VALUES ($1, $2, 'Old course') RETURNING id`,
        [term, `OLD${seq}`],
      )
    ).rows[0]!.id;
    await c.query('INSERT INTO lecturer_courses (course_id, lecturer_id) VALUES ($1, $2)', [
      courseId,
      lecturerId,
    ]);
    await c.query('COMMIT');
    const students = await createBulkStudents(db, 3);
    const sessionId = (
      await db.pool.query<{ id: string }>(
        `INSERT INTO class_sessions (course_id, created_by, title, session_date, state, started_at, started_by, check_in_deadline)
       VALUES ($1, $2, 'Old class', current_date - 400, 'CHECK_IN_OPEN', now() - interval '400 days', $2, now() - interval '400 days' + interval '30 minutes') RETURNING id`,
        [courseId, lecturerId],
      )
    ).rows[0]!.id;
    await db.pool.query(
      `INSERT INTO session_extensions (session_id, extended_by, previous_deadline, new_deadline, reason)
       SELECT id, $2, check_in_deadline, check_in_deadline + interval '5 minutes', 'Overran' FROM class_sessions WHERE id = $1`,
      [sessionId, lecturerId],
    );

    const imp = (
      await db.pool.query<{ id: string }>(
        `INSERT INTO roster_imports (course_id, uploaded_by, file_sha256, row_count, status) VALUES ($1, $2, '\\x00', 2, 'APPLIED') RETURNING id`,
        [courseId, lecturerId],
      )
    ).rows[0]!.id;
    // An entry that superseded another (self-referencing foreign key).
    const oldEntry = (
      await db.pool.query<{ id: string }>(
        `INSERT INTO roster_entries (course_id, import_id, student_id_norm, full_name, retired_at) VALUES ($1, $2, $3, 'Old Name', now()) RETURNING id`,
        [courseId, imp, students[0]!.studentId],
      )
    ).rows[0]!.id;
    const newEntry = (
      await db.pool.query<{ id: string }>(
        `INSERT INTO roster_entries (course_id, import_id, student_id_norm, full_name) VALUES ($1, $2, $3, 'New Name') RETURNING id`,
        [courseId, imp, students[0]!.studentId],
      )
    ).rows[0]!.id;
    await db.pool.query('UPDATE roster_entries SET superseded_by = $2 WHERE id = $1', [
      oldEntry,
      newEntry,
    ]);

    const w = await db.pool.connect();
    try {
      await w.query('BEGIN');
      for (const [i, s] of students.entries()) {
        const link = (
          await w.query<{ id: string }>(
            `INSERT INTO roster_links (course_id, student_id, roster_entry_id, state, confirmed_basis) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
            [
              courseId,
              s.id,
              i === 0 ? newEntry : null,
              i === 0 ? 'CONFIRMED' : 'PROVISIONAL',
              i === 0 ? 'ROSTER_ID_MATCH' : null,
            ],
          )
        ).rows[0]!.id;
        await w.query(
          `INSERT INTO identity_reviews (link_id, review_no, review_kind, decision, from_state, to_state, to_entry_id, basis) VALUES ($1, 1, 'SYSTEM_MATCH', 'SYSTEM_MATCH', NULL, $2, $3, $4)`,
          [
            link,
            i === 0 ? 'CONFIRMED' : 'PROVISIONAL',
            i === 0 ? newEntry : null,
            i === 0 ? 'ROSTER_ID_MATCH' : null,
          ],
        );
        const att = (
          await w.query<{ id: string }>(
            `INSERT INTO attendance_records (session_id, course_id, student_id, link_id, source) VALUES ($1, $2, $3, $4, 'QR_SCAN') RETURNING id`,
            [sessionId, courseId, s.id, link],
          )
        ).rows[0]!.id;
        await w.query(
          `INSERT INTO attendance_revisions (attendance_id, rev_no, change_kind, from_status, to_status, actor_user_id) VALUES ($1, 1, 'CREATED_QR', NULL, 'PRESENT', $2)`,
          [att, s.id],
        );
        await w.query(
          `INSERT INTO scan_attempts (session_id, student_id, client_attempt_id, token_jti, token_kid, outcome, attendance_id, received_at) VALUES ($1, $2, gen_random_uuid(), 'j', 'k1', 'ACCEPTED', $3, now() - interval '400 days')`,
          [sessionId, s.id, att],
        );
        if (i === 1) {
          const flag = (
            await w.query<{ id: string }>(
              `INSERT INTO investigation_flags (course_id, attendance_id, roster_link_id, kind, origin, raised_by, state, current_event_no) VALUES ($1, $2, $3, 'PROXY_SUSPECTED', 'LECTURER', $4, 'UNDER_REVIEW', 2) RETURNING id`,
              [courseId, att, link, lecturerId],
            )
          ).rows[0]!.id;
          await w.query(
            `INSERT INTO investigation_flag_events (flag_id, event_no, from_state, to_state, actor_user_id, note) VALUES ($1, 1, NULL, 'OPEN', $2, 'Raised'), ($1, 2, 'OPEN', 'UNDER_REVIEW', $2, NULL)`,
            [flag, lecturerId],
          );
          await w.query(
            `INSERT INTO identity_reviews (link_id, review_no, review_kind, decision, from_state, to_state, actor_user_id, explanation, flag_id) VALUES ($1, 2, 'ENROLLMENT', 'MARK_REVIEW_REQUIRED', 'PROVISIONAL', 'REVIEW_REQUIRED', $2, 'Needs a closer look', $3)`,
            [link, lecturerId, flag],
          );
          await w.query(
            `UPDATE roster_links SET state = 'REVIEW_REQUIRED', current_review_no = 2 WHERE id = $1`,
            [link],
          );
        }
      }
      await w.query(
        `INSERT INTO export_records (course_id, session_id, requested_by, report_kind, format, status) VALUES ($1, $2, $3, 'ATTENDANCE', 'CSV', 'EXPIRED')`,
        [courseId, sessionId, lecturerId],
      );
      await w.query(
        `INSERT INTO audit_events (class, actor_type, action, course_id, session_id, retain_until) VALUES ('DOMAIN', 'LECTURER', 'SESSION_STARTED', $1, $2, current_date - 1)`,
        [courseId, sessionId],
      );
      await w.query('COMMIT');
    } catch (err) {
      await w.query('ROLLBACK');
      throw err;
    } finally {
      w.release();
    }
    return { courseId, students, sessionId };
  } finally {
    c.release();
  }
}

describe('RET-01 scan metadata is purged at 90 days and nothing else about the record is touched', () => {
  it('keeps a scan from 89 days 23 hours ago and removes one from 90 days 1 minute ago', async () => {
    const { courseId, sessionId } = await seedCourse(-30); // course still within its retention period
    const [s] = await createBulkStudents(db, 1);
    const att = (
      await db.pool.query<{ id: string }>(
        'SELECT id FROM attendance_records WHERE session_id = $1 LIMIT 1',
        [sessionId],
      )
    ).rows[0]!.id;
    const insert = (age: string, tag: string) =>
      db.pool.query(
        `INSERT INTO scan_attempts (session_id, student_id, client_attempt_id, token_jti, token_kid, outcome, attendance_id, received_at)
         VALUES ($1, $2, gen_random_uuid(), $3, 'k1', 'DUPLICATE_EXISTING', $4, clock_timestamp() - $5::interval)`,
        [sessionId, (s ?? { id: '' }).id, tag, att, age],
      );
    // The seeded scans are 400 days old; add the two boundary cases.
    await insert('89 days 23 hours', 'keep-me');
    await insert('90 days 1 minute', 'drop-me');
    const attendanceBefore = await n('SELECT 1 FROM attendance_records WHERE course_id = $1', [
      courseId,
    ]);
    const revisionsBefore = await n(
      'SELECT 1 FROM attendance_revisions r JOIN attendance_records a ON a.id = r.attendance_id WHERE a.course_id = $1',
      [courseId],
    );

    const report = await runRetention(db.retentionPool);
    expect(report.scanAttempts).toBeGreaterThanOrEqual(4);
    const remaining = (
      await db.pool.query<{ token_jti: string }>(
        'SELECT token_jti FROM scan_attempts WHERE session_id = $1',
        [sessionId],
      )
    ).rows.map((r) => r.token_jti);
    expect(remaining).toEqual(['keep-me']);
    expect(await n('SELECT 1 FROM attendance_records WHERE course_id = $1', [courseId])).toBe(
      attendanceBefore,
    );
    expect(
      await n(
        'SELECT 1 FROM attendance_revisions r JOIN attendance_records a ON a.id = r.attendance_id WHERE a.course_id = $1',
        [courseId],
      ),
    ).toBe(revisionsBefore);
  });
});

describe('RET-02 a course is purged the day after term end + 1 year, completely and in order', () => {
  it('keeps a course on its last retention day and purges the next day', async () => {
    const keep = await seedCourse(0); // term end + 1 year == today: still retained
    const gone = await seedCourse(1); // one day overdue
    const future = await seedCourse(-200);

    const withoutScans = async (id: string) => {
      const { scan_attempts: _scans, ...rest } = await rowsFor(id);
      return rest;
    };
    const before = {
      keep: await withoutScans(keep.courseId),
      future: await withoutScans(future.courseId),
    };
    expect(before.keep.attendance_records).toBe(3);
    expect((await rowsFor(gone.courseId)).attendance_records).toBe(3);

    const report = await runRetention(db.retentionPool);
    expect(report.coursesPurged).toBeGreaterThanOrEqual(1);

    // Every table, empty for the purged course...
    expect(
      Object.values(await rowsFor(gone.courseId)).every((count) => count === 0),
      JSON.stringify(await rowsFor(gone.courseId)),
    ).toBe(true);
    // ...and completely untouched for the others.
    expect(await withoutScans(keep.courseId)).toEqual(before.keep);
    expect(await withoutScans(future.courseId)).toEqual(before.future);
    // The seeded scans are 400 days old, so the separate 90-day rule removes them even from kept courses.
    expect((await rowsFor(keep.courseId)).scan_attempts).toBe(0);
  });

  it('does not delete student accounts just because their course was purged', async () => {
    const old = await seedCourse(5);
    const keptCourse = await seedCourse(-100);
    await runRetention(db.retentionPool);
    expect((await rowsFor(old.courseId)).courses).toBe(0);
    expect((await rowsFor(keptCourse.courseId)).attendance_records).toBe(3);
    // Accounts outlive any one course; only the idle-account rule below can remove them.
    expect(
      await n('SELECT 1 FROM users WHERE id = ANY($1::uuid[])', [old.students.map((x) => x.id)]),
    ).toBe(3);
  });

  it('removes a term only when it is past retention and has no courses left', async () => {
    const gone = await seedCourse(10);
    const termId = (
      await db.pool.query<{ term_id: string }>('SELECT term_id FROM courses WHERE id = $1', [
        gone.courseId,
      ])
    ).rows[0]!.term_id;
    await runRetention(db.retentionPool);
    expect(await n('SELECT 1 FROM terms WHERE id = $1', [termId])).toBe(0);
    const keep = await seedCourse(0);
    const keepTerm = (
      await db.pool.query<{ term_id: string }>('SELECT term_id FROM courses WHERE id = $1', [
        keep.courseId,
      ])
    ).rows[0]!.term_id;
    await runRetention(db.retentionPool);
    expect(await n('SELECT 1 FROM terms WHERE id = $1', [keepTerm])).toBe(1);
  });
});

describe('RET-03 sign-in sessions, tokens and counters are cleaned up after a grace period', () => {
  it('removes expired and revoked sessions after 7 days, never live ones', async () => {
    const [u] = await createBulkStudents(db, 1);
    const hash = () => randomBytes(32);
    const add = (idle: string, abs: string, revoked: string | null) =>
      db.pool.query(
        `INSERT INTO auth_sessions (id_hash, user_id, idle_expires_at, absolute_expires_at, revoked_at)
         VALUES ($1, $2, now() + $3::interval, now() + $4::interval, CASE WHEN $5::text IS NULL THEN NULL ELSE now() + $5::interval END)`,
        [hash(), u!.id, idle, abs, revoked],
      );
    const before = await n('SELECT 1 FROM auth_sessions WHERE user_id = $1', [u!.id]); // the bulk helper's live session
    await add('-8 days', '-8 days', null); // long expired -> purge
    await add('-6 days', '-6 days', null); // expired recently -> keep
    await add('1 day', '5 days', '-8 days'); // revoked long ago -> purge
    await add('1 day', '5 days', '-1 day'); // revoked yesterday -> keep
    await add('1 day', '5 days', null); // live -> keep
    const report = await runRetention(db.retentionPool);
    expect(report.authSessions).toBeGreaterThanOrEqual(2);
    expect(await n('SELECT 1 FROM auth_sessions WHERE user_id = $1', [u!.id])).toBe(before + 3);
  });

  it('removes spent or expired account tokens after 7 days, and old rate-limit windows after a day', async () => {
    const [u] = await createBulkStudents(db, 1);
    const tok = (exp: string, used: string | null) =>
      db.pool.query(
        `INSERT INTO account_tokens (token_hash, user_id, purpose, expires_at, used_at) VALUES ($1, $2, 'EMAIL_VERIFICATION', now() + $3::interval, CASE WHEN $4::text IS NULL THEN NULL ELSE now() + $4::interval END)`,
        [randomBytes(32), u!.id, exp, used],
      );
    await tok('-8 days', null); // purge
    await tok('-1 day', null); // keep
    await tok('5 days', '-8 days'); // used long ago -> purge
    await tok('5 days', null); // pending -> keep
    await db.pool.query(
      `INSERT INTO rate_limits (key_hash, window_start, count) VALUES ($1, now() - interval '2 days', 5), ($2, now(), 1)`,
      [randomBytes(32), randomBytes(32)],
    );
    const report = await runRetention(db.retentionPool);
    expect(report.accountTokens).toBeGreaterThanOrEqual(2);
    expect(await n('SELECT 1 FROM account_tokens WHERE user_id = $1', [u!.id])).toBe(2);
    expect(report.rateLimits).toBeGreaterThanOrEqual(1);
  });

  it('removes security audit events past their 90 days and leaves course audit to the course purge', async () => {
    await db.pool.query(
      `INSERT INTO audit_events (class, actor_type, action, retain_until) VALUES ('SECURITY', 'ANONYMOUS', 'OLD_LOGIN_FAILED', current_date - 1), ('SECURITY', 'ANONYMOUS', 'RECENT_LOGIN_FAILED', current_date + 30)`,
    );
    const keepCourse = await seedCourse(-50);
    await db.pool.query(
      `INSERT INTO audit_events (class, actor_type, action, course_id, retain_until) VALUES ('DOMAIN', 'LECTURER', 'KEEP_DOMAIN', $1, current_date - 1)`,
      [keepCourse.courseId],
    );
    await runRetention(db.retentionPool);
    expect(await n(`SELECT 1 FROM audit_events WHERE action = 'OLD_LOGIN_FAILED'`)).toBe(0);
    expect(await n(`SELECT 1 FROM audit_events WHERE action = 'RECENT_LOGIN_FAILED'`)).toBe(1);
    expect(await n(`SELECT 1 FROM audit_events WHERE action = 'KEEP_DOMAIN'`)).toBe(1); // governed by its course, not by its own date
  });
});

describe('inactive student accounts', () => {
  it('removes only old, idle, unreferenced student accounts', async () => {
    const [idle, recent] = await createBulkStudents(db, 2);
    const kept = await seedCourse(-100); // its students have attendance records and matches
    const referenced = kept.students[0]!;
    const old = [idle!.id, referenced.id];
    await db.pool.query(
      `UPDATE users SET created_at = now() - interval '13 months' WHERE id = ANY($1::uuid[])`,
      [old],
    );
    await db.pool.query(
      `UPDATE auth_sessions SET last_seen_at = now() - interval '13 months', idle_expires_at = now() - interval '12 months',
              absolute_expires_at = now() - interval '12 months' WHERE user_id = ANY($1::uuid[])`,
      [old],
    );

    const report = await runRetention(db.retentionPool);
    expect(report.accountsPurged).toBeGreaterThanOrEqual(1);
    expect(await n('SELECT 1 FROM users WHERE id = $1', [idle!.id])).toBe(0); // old, idle, nothing refers to it
    expect(await n('SELECT 1 FROM users WHERE id = $1', [referenced.id])).toBe(1); // attendance still refers to it
    expect(await n('SELECT 1 FROM users WHERE id = $1', [recent!.id])).toBe(1); // too new
    expect(await n(`SELECT 1 FROM users WHERE id = $1 AND role = 'LECTURER'`, [lecturerId])).toBe(
      1,
    ); // lecturers are never auto-removed
  });
});

describe('RET-04 retention is a function of the data, so it is safe after a restore', () => {
  it('re-deletes expired data that comes back from an old backup, and a second run changes nothing', async () => {
    const doomed = await seedCourse(3);
    await runRetention(db.retentionPool);
    expect((await rowsFor(doomed.courseId)).courses).toBe(0);

    // "Restore": the same expired data reappears, as if an old backup were loaded.
    const resurrected = await seedCourse(3);
    expect((await rowsFor(resurrected.courseId)).attendance_records).toBe(3);
    await db.pool.query(
      `INSERT INTO scan_attempts (session_id, student_id, client_attempt_id, token_jti, token_kid, outcome, received_at)
      VALUES ($1, $2, gen_random_uuid(), 'old', 'k', 'REJECTED_SESSION_CLOSED', now() - interval '200 days')`,
      [resurrected.sessionId, resurrected.students[0]!.id],
    );

    const first = await runRetention(db.retentionPool);
    expect(first.coursesPurged).toBeGreaterThanOrEqual(1);
    expect(Object.values(await rowsFor(resurrected.courseId)).every((c) => c === 0)).toBe(true);

    const second = await runRetention(db.retentionPool);
    expect(second).toEqual({
      scanAttempts: 0,
      faceDetail: 0,
      securityAudit: 0,
      authSessions: 0,
      accountTokens: 0,
      rateLimits: 0,
      coursesPurged: 0,
      termsPurged: 0,
      accountsPurged: 0,
      accountsDeleted: 0,
    });
  });

  it('a failed purge of one course leaves it whole, not half-deleted', async () => {
    const doomed = await seedCourse(7);
    await db.pool.query(
      `CREATE OR REPLACE FUNCTION block_course_delete() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'simulated failure'; END $$`,
    );
    await db.pool.query(
      `CREATE TRIGGER block_course_delete_trg BEFORE DELETE ON courses FOR EACH ROW EXECUTE FUNCTION block_course_delete()`,
    );
    const withoutScans = async () => {
      const { scan_attempts: _scans, ...rest } = await rowsFor(doomed.courseId);
      return rest;
    };
    const before = await withoutScans();
    try {
      await expect(runRetention(db.retentionPool)).rejects.toThrow(/simulated failure/);
    } finally {
      await db.pool.query('DROP TRIGGER block_course_delete_trg ON courses');
    }
    expect(await withoutScans()).toEqual(before); // all-or-nothing (scan metadata follows its own 90-day rule)
    await runRetention(db.retentionPool);
    expect((await rowsFor(doomed.courseId)).courses).toBe(0); // and it completes on the next run
  });
});

describe('the retention role can only read and delete', () => {
  it('cannot insert, update or alter anything', async () => {
    for (const sql of [
      `INSERT INTO audit_events (class, actor_type, action, retain_until) VALUES ('DOMAIN','SYSTEM','X', current_date)`,
      `UPDATE users SET status = 'DISABLED'`,
      `UPDATE attendance_records SET status = 'INVALIDATED'`,
      `CREATE TABLE sneaky (id int)`,
    ]) {
      await expect(db.retentionPool.query(sql), sql).rejects.toMatchObject({ code: '42501' });
    }
  });
});

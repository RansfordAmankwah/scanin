import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAttendance, createFixture, createSession, type Fixture } from '../helpers/seed.js';
import { createMigratedTestDatabase, type MigratedTestDatabase } from '../helpers/testDb.js';

let db: MigratedTestDatabase;
let f: Fixture;
let sessionId: string;
let attendanceId: string;

beforeAll(async () => {
  db = await createMigratedTestDatabase();
  f = await createFixture(db.pool);
  sessionId = await createSession(db.pool, f.courseId, f.lecturerId, 'CHECK_IN_OPEN');
  attendanceId = await createAttendance(db.pool, f, sessionId);
  await db.pool.query(
    `INSERT INTO audit_events (class, actor_type, action, retain_until)
     VALUES ('DOMAIN', 'SYSTEM', 'TEST_EVENT', current_date + 365)`,
  );
  await db.pool.query(
    `INSERT INTO scan_attempts (session_id, student_id, client_attempt_id, token_jti, token_kid, outcome, attendance_id)
     VALUES ($1, $2, gen_random_uuid(), 'jti', 'k1', 'ACCEPTED', $3)`,
    [sessionId, f.studentId, attendanceId],
  );
  await db.pool.query(
    `INSERT INTO session_extensions (session_id, extended_by, previous_deadline, new_deadline, reason)
     SELECT id, $2, check_in_deadline, check_in_deadline + interval '10 minutes', 'Overran' FROM class_sessions WHERE id = $1`,
    [sessionId, f.lecturerId],
  );
});

afterAll(async () => {
  await db?.drop();
});

const APPEND_ONLY = [
  'audit_events',
  'attendance_revisions',
  'identity_reviews',
  'investigation_flag_events',
  'session_extensions',
  'scan_attempts',
] as const;

// A real, nullable-or-not column per table, so the denial is about privilege, not a bad column.
const EDITABLE_COLUMN: Record<(typeof APPEND_ONLY)[number], string> = {
  audit_events: 'action',
  attendance_revisions: 'explanation',
  identity_reviews: 'explanation',
  investigation_flag_events: 'note',
  session_extensions: 'reason',
  scan_attempts: 'ua_family',
};

describe('AUD-02 the application role cannot edit or delete history', () => {
  it.each(APPEND_ONLY)('%s: UPDATE is denied to the app role', async (table) => {
    await expect(
      db.asRole(db.appRole, (c) => c.query(`UPDATE ${table} SET ${EDITABLE_COLUMN[table]} = NULL`)),
    ).rejects.toMatchObject({ code: '42501' });
  });

  it.each(APPEND_ONLY)('%s: DELETE is denied to the app role', async (table) => {
    await expect(
      db.asRole(db.appRole, (c) => c.query(`DELETE FROM ${table}`)),
    ).rejects.toMatchObject({
      code: '42501',
    });
  });

  it.each(APPEND_ONLY)('%s: TRUNCATE is denied to the app role', async (table) => {
    await expect(db.asRole(db.appRole, (c) => c.query(`TRUNCATE ${table}`))).rejects.toMatchObject({
      code: '42501',
    });
  });

  it('still lets the app role append and read audit events', async () => {
    await db.asRole(db.appRole, async (c) => {
      await c.query(
        `INSERT INTO audit_events (class, actor_type, action, retain_until)
         VALUES ('SECURITY', 'ANONYMOUS', 'LOGIN_FAILED', current_date + 90)`,
      );
      const { rows } = await c.query('SELECT count(*)::int AS n FROM audit_events');
      expect(rows[0].n).toBeGreaterThanOrEqual(2);
    });
  });
});

describe('the application role has only the column-level updates it needs', () => {
  it('cannot change a user role, student ID or e-mail', async () => {
    for (const col of ['role', 'student_id_norm', 'email', 'full_name']) {
      const value = col === 'role' ? `'LECTURER'` : `'changed'`;
      await expect(
        db.asRole(db.appRole, (c) =>
          c.query(`UPDATE users SET ${col} = ${value} WHERE id = $1`, [f.studentId]),
        ),
      ).rejects.toMatchObject({ code: '42501' });
    }
  });

  it('can update a password hash', async () => {
    await db.asRole(db.appRole, (c) =>
      c.query(`UPDATE users SET password_hash = 'new' WHERE id = $1`, [f.studentId]),
    );
  });

  it('cannot rewrite who or when an attendance record was made', async () => {
    for (const set of [
      `recorded_at = now()`,
      `student_id = student_id`,
      `source = 'MANUAL'`,
      `session_id = session_id`,
    ]) {
      await expect(
        db.asRole(db.appRole, (c) =>
          c.query(`UPDATE attendance_records SET ${set} WHERE id = $1`, [attendanceId]),
        ),
      ).rejects.toMatchObject({ code: '42501' });
    }
  });

  it('cannot delete attendance, sessions, links or users', async () => {
    for (const table of [
      'attendance_records',
      'class_sessions',
      'roster_links',
      'users',
      'courses',
    ]) {
      await expect(
        db.asRole(db.appRole, (c) => c.query(`DELETE FROM ${table}`)),
      ).rejects.toMatchObject({
        code: '42501',
      });
    }
  });

  it('cannot create lecturers-to-course assignments or courses (operator-only)', async () => {
    await expect(
      db.asRole(db.appRole, (c) =>
        c.query(`INSERT INTO lecturer_courses (course_id, lecturer_id) VALUES ($1, $2)`, [
          f.courseId,
          f.lecturerId,
        ]),
      ),
    ).rejects.toMatchObject({ code: '42501' });
  });
});

describe('the retention role can only read and delete', () => {
  it('can delete expired scan metadata', async () => {
    await db.asRole(db.retentionRole, async (c) => {
      await c.query(`DELETE FROM scan_attempts WHERE received_at < now() - interval '90 days'`);
    });
  });

  it('cannot insert or update', async () => {
    await expect(
      db.asRole(db.retentionRole, (c) =>
        c.query(
          `INSERT INTO audit_events (class, actor_type, action, retain_until) VALUES ('DOMAIN','SYSTEM','X', current_date)`,
        ),
      ),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(
      db.asRole(db.retentionRole, (c) => c.query(`UPDATE users SET status = 'DISABLED'`)),
    ).rejects.toMatchObject({ code: '42501' });
  });
});

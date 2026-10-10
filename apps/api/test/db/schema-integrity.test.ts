import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createAttendance,
  createFixture,
  createSession,
  createStudent,
  createLecturer,
  createLink,
  createTerm,
  createCourse,
  tx,
} from '../helpers/seed.js';
import { createMigratedTestDatabase, type MigratedTestDatabase } from '../helpers/testDb.js';

let db: MigratedTestDatabase;

beforeAll(async () => {
  db = await createMigratedTestDatabase();
});

afterAll(async () => {
  await db?.drop();
});

describe('AUTHZ-03 role-correct references', () => {
  it('rejects assigning a student account as a lecturer', async () => {
    const termId = await createTerm(db.pool);
    const courseId = await createCourse(db.pool, termId);
    const studentId = await createStudent(db.pool);
    await expect(
      db.pool.query('INSERT INTO lecturer_courses (course_id, lecturer_id) VALUES ($1, $2)', [
        courseId,
        studentId,
      ]),
    ).rejects.toMatchObject({ code: '23503', constraint: 'lecturer_courses_lecturer_fk' });
  });

  it('rejects attendance and links for a lecturer account', async () => {
    const f = await createFixture(db.pool);
    await expect(
      db.pool.query('INSERT INTO roster_links (course_id, student_id, state) VALUES ($1, $2, $3)', [
        f.courseId,
        f.lecturerId,
        'PROVISIONAL',
      ]),
    ).rejects.toMatchObject({ code: '23503' });
  });

  it('accepts a real lecturer assignment', async () => {
    const termId = await createTerm(db.pool);
    const courseId = await createCourse(db.pool, termId);
    const lecturerId = await createLecturer(db.pool);
    await db.pool.query('INSERT INTO lecturer_courses (course_id, lecturer_id) VALUES ($1, $2)', [
      courseId,
      lecturerId,
    ]);
  });

  it('requires a student ID for students and forbids one for lecturers', async () => {
    await expect(
      db.pool.query(
        `INSERT INTO users (role, email, full_name, password_hash)
         VALUES ('STUDENT', 'no-id@example.test', 'No Id', 'x')`,
      ),
    ).rejects.toMatchObject({ code: '23514', constraint: 'users_student_id_iff_student' });
    await expect(
      db.pool.query(
        `INSERT INTO users (role, email, full_name, student_id_norm, student_id_display, password_hash)
         VALUES ('LECTURER', 'lec-id@example.test', 'Lec', 'S1', 'S1', 'x')`,
      ),
    ).rejects.toMatchObject({ code: '23514' });
  });
});

describe('AUTH-01 one account per student ID, atomically', () => {
  it('lets exactly one of 20 parallel registrations with the same ID win', async () => {
    const attempts = Array.from({ length: 20 }, (_, i) =>
      db.pool.query(
        `INSERT INTO users (role, email, full_name, student_id_norm, student_id_display, password_hash)
         VALUES ('STUDENT', $1, 'Racer', 'RACE-1', 'RACE-1', 'x')`,
        [`racer-${i}@example.test`],
      ),
    );
    const results = await Promise.allSettled(attempts);
    const ok = results.filter((r) => r.status === 'fulfilled');
    const failed = results.filter((r) => r.status === 'rejected');
    expect(ok).toHaveLength(1);
    expect(failed).toHaveLength(19);
    for (const r of failed) {
      expect((r as PromiseRejectedResult).reason).toMatchObject({
        code: '23505',
        constraint: 'users_student_id_norm_key',
      });
    }
  });
});

describe('one effective attendance record per student per session', () => {
  it('rejects a second record for the same (session, student)', async () => {
    const f = await createFixture(db.pool);
    const sessionId = await createSession(db.pool, f.courseId, f.lecturerId, 'CHECK_IN_OPEN');
    await createAttendance(db.pool, f, sessionId);
    await expect(createAttendance(db.pool, f, sessionId)).rejects.toMatchObject({
      code: '23505',
      constraint: 'attendance_session_student_key',
    });
  });

  it('rejects attendance whose link belongs to a different student or course', async () => {
    const f = await createFixture(db.pool);
    const other = await createFixture(db.pool);
    const sessionId = await createSession(db.pool, f.courseId, f.lecturerId, 'CHECK_IN_OPEN');
    await expect(
      tx(db.pool, async (c) => {
        const { rows } = await c.query<{ id: string }>(
          `INSERT INTO attendance_records (session_id, course_id, student_id, link_id, source)
           VALUES ($1, $2, $3, $4, 'QR_SCAN') RETURNING id`,
          [sessionId, f.courseId, f.studentId, other.linkId],
        );
        await c.query(
          `INSERT INTO attendance_revisions (attendance_id, rev_no, change_kind, from_status, to_status, actor_user_id)
           VALUES ($1, 1, 'CREATED_QR', NULL, 'PRESENT', $2)`,
          [rows[0]?.id, f.studentId],
        );
      }),
    ).rejects.toMatchObject({ code: '23503', constraint: 'attendance_link_fk' });
  });
});

describe('ATT-06 status always matches the latest revision', () => {
  it('rejects changing status without a matching new revision', async () => {
    const f = await createFixture(db.pool);
    const sessionId = await createSession(db.pool, f.courseId, f.lecturerId, 'CHECK_IN_OPEN');
    const attendanceId = await createAttendance(db.pool, f, sessionId);
    await expect(
      db.pool.query(`UPDATE attendance_records SET status = 'INVALIDATED' WHERE id = $1`, [
        attendanceId,
      ]),
    ).rejects.toMatchObject({ code: '23503', constraint: 'attendance_status_matches_revision' });
  });

  it('rejects a record with no first revision (checked at commit)', async () => {
    const f = await createFixture(db.pool);
    const sessionId = await createSession(db.pool, f.courseId, f.lecturerId, 'CHECK_IN_OPEN');
    await expect(
      db.pool.query(
        `INSERT INTO attendance_records (session_id, course_id, student_id, link_id, source)
         VALUES ($1, $2, $3, $4, 'QR_SCAN')`,
        [sessionId, f.courseId, f.studentId, f.linkId],
      ),
    ).rejects.toMatchObject({ code: '23503', constraint: 'attendance_status_matches_revision' });
  });

  it('accepts invalidation and restoration when each has its revision', async () => {
    const f = await createFixture(db.pool);
    const sessionId = await createSession(db.pool, f.courseId, f.lecturerId, 'CHECK_IN_OPEN');
    const id = await createAttendance(db.pool, f, sessionId);

    await tx(db.pool, async (c) => {
      await c.query(
        `INSERT INTO attendance_revisions
           (attendance_id, rev_no, change_kind, from_status, to_status, actor_user_id, reason_category, explanation)
         VALUES ($1, 2, 'INVALIDATED', 'PRESENT', 'INVALIDATED', $2, 'INCORRECT_ENTRY', 'Marked in error by mistake')`,
        [id, f.lecturerId],
      );
      await c.query(
        `UPDATE attendance_records SET status = 'INVALIDATED', current_rev_no = 2 WHERE id = $1`,
        [id],
      );
    });
    await tx(db.pool, async (c) => {
      await c.query(
        `INSERT INTO attendance_revisions
           (attendance_id, rev_no, change_kind, from_status, to_status, actor_user_id, explanation)
         VALUES ($1, 3, 'RESTORED', 'INVALIDATED', 'PRESENT', $2, 'Lecturer confirmed attendance in person')`,
        [id, f.lecturerId],
      );
      await c.query(
        `UPDATE attendance_records SET status = 'PRESENT', current_rev_no = 3 WHERE id = $1`,
        [id],
      );
    });

    const { rows } = await db.pool.query<{ rev_no: number }>(
      'SELECT rev_no FROM attendance_revisions WHERE attendance_id = $1 ORDER BY rev_no',
      [id],
    );
    expect(rows.map((r) => r.rev_no)).toEqual([1, 2, 3]);
  });
});

describe('ATT-04 invalidation needs a reason category and written explanation', () => {
  it.each([
    ['no category', `NULL, 'A proper written explanation'`],
    ['no explanation', `'OTHER', NULL`],
    ['too-short explanation', `'OTHER', 'short'`],
    ['blank explanation', `'OTHER', '          '`],
  ])('rejects invalidation with %s', async (_label, values) => {
    const f = await createFixture(db.pool);
    const sessionId = await createSession(db.pool, f.courseId, f.lecturerId, 'CHECK_IN_OPEN');
    const id = await createAttendance(db.pool, f, sessionId);
    await expect(
      db.pool.query(
        `INSERT INTO attendance_revisions
           (attendance_id, rev_no, change_kind, from_status, to_status, actor_user_id, reason_category, explanation)
         VALUES ($1, 2, 'INVALIDATED', 'PRESENT', 'INVALIDATED', $2, ${values})`,
        [id, f.lecturerId],
      ),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('requires an explanation for manual attendance', async () => {
    const f = await createFixture(db.pool);
    const sessionId = await createSession(db.pool, f.courseId, f.lecturerId, 'CHECK_IN_OPEN');
    await expect(
      tx(db.pool, async (c) => {
        const { rows } = await c.query<{ id: string }>(
          `INSERT INTO attendance_records (session_id, course_id, student_id, link_id, source, manual_marked_by)
           VALUES ($1, $2, $3, $4, 'MANUAL', $5) RETURNING id`,
          [sessionId, f.courseId, f.studentId, f.linkId, f.lecturerId],
        );
        await c.query(
          `INSERT INTO attendance_revisions (attendance_id, rev_no, change_kind, from_status, to_status, actor_user_id)
           VALUES ($1, 1, 'CREATED_MANUAL', NULL, 'PRESENT', $2)`,
          [rows[0]?.id, f.lecturerId],
        );
      }),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('keeps QR and MANUAL sources distinguishable by who marked them', async () => {
    const f = await createFixture(db.pool);
    const sessionId = await createSession(db.pool, f.courseId, f.lecturerId, 'CHECK_IN_OPEN');
    await expect(
      db.pool.query(
        `INSERT INTO attendance_records (session_id, course_id, student_id, link_id, source)
         VALUES ($1, $2, $3, $4, 'MANUAL')`,
        [sessionId, f.courseId, f.studentId, f.linkId],
      ),
    ).rejects.toMatchObject({ code: '23514', constraint: 'attendance_manual_actor' });
  });
});

describe('roster holder uniqueness (no silent merge)', () => {
  it('lets only one non-rejected link hold a roster entry', async () => {
    const termId = await createTerm(db.pool);
    const courseId = await createCourse(db.pool, termId);
    const lecturerId = await createLecturer(db.pool);
    const a = await createStudent(db.pool);
    const b = await createStudent(db.pool);

    const importId = (
      await db.pool.query<{ id: string }>(
        `INSERT INTO roster_imports (course_id, uploaded_by, file_sha256, row_count, status)
         VALUES ($1, $2, '\\x00', 1, 'APPLIED') RETURNING id`,
        [courseId, lecturerId],
      )
    ).rows[0]?.id;
    const entryId = (
      await db.pool.query<{ id: string }>(
        `INSERT INTO roster_entries (course_id, import_id, student_id_norm, full_name)
         VALUES ($1, $2, 'ID-100', 'Rostered Person') RETURNING id`,
        [courseId, importId],
      )
    ).rows[0]?.id;

    const insertConfirmedLink = (studentId: string) =>
      tx(db.pool, async (c) => {
        const { rows } = await c.query<{ id: string }>(
          `INSERT INTO roster_links (course_id, student_id, roster_entry_id, state, confirmed_basis)
           VALUES ($1, $2, $3, 'CONFIRMED', 'ROSTER_ID_MATCH') RETURNING id`,
          [courseId, studentId, entryId],
        );
        await c.query(
          `INSERT INTO identity_reviews (link_id, review_no, review_kind, decision, from_state, to_state, basis)
           VALUES ($1, 1, 'SYSTEM_MATCH', 'SYSTEM_MATCH', NULL, 'CONFIRMED', 'ROSTER_ID_MATCH')`,
          [rows[0]?.id],
        );
      });

    await insertConfirmedLink(a);
    await expect(insertConfirmedLink(b)).rejects.toMatchObject({
      code: '23505',
      constraint: 'roster_links_entry_holder_key',
    });
    // The second claimant can still exist, but only without the entry and under review.
    await createLink(db.pool, courseId, b, { state: 'REVIEW_REQUIRED' });
  });

  it('keeps only one ACTIVE roster entry per student ID in a course', async () => {
    const termId = await createTerm(db.pool);
    const courseId = await createCourse(db.pool, termId);
    const lecturerId = await createLecturer(db.pool);
    const importId = (
      await db.pool.query<{ id: string }>(
        `INSERT INTO roster_imports (course_id, uploaded_by, file_sha256, row_count, status)
         VALUES ($1, $2, '\\x00', 2, 'APPLIED') RETURNING id`,
        [courseId, lecturerId],
      )
    ).rows[0]?.id;
    const insert = () =>
      db.pool.query(
        `INSERT INTO roster_entries (course_id, import_id, student_id_norm, full_name)
         VALUES ($1, $2, 'DUP-1', 'Someone')`,
        [courseId, importId],
      );
    await insert();
    await expect(insert()).rejects.toMatchObject({ code: '23505' });
  });
});

describe('link state matches its latest review', () => {
  it('rejects a link whose state has no matching review row', async () => {
    const termId = await createTerm(db.pool);
    const courseId = await createCourse(db.pool, termId);
    const studentId = await createStudent(db.pool);
    await expect(
      db.pool.query(
        `INSERT INTO roster_links (course_id, student_id, state) VALUES ($1, $2, 'PROVISIONAL')`,
        [courseId, studentId],
      ),
    ).rejects.toMatchObject({ code: '23503', constraint: 'roster_links_state_matches_review' });
  });
});

describe('investigation flags are independent of attendance', () => {
  it('records a substantiated flag without touching attendance', async () => {
    const f = await createFixture(db.pool);
    const sessionId = await createSession(db.pool, f.courseId, f.lecturerId, 'CHECK_IN_OPEN');
    const attendanceId = await createAttendance(db.pool, f, sessionId);

    await tx(db.pool, async (c) => {
      const { rows } = await c.query<{ id: string }>(
        `INSERT INTO investigation_flags (course_id, attendance_id, kind, origin, raised_by)
         VALUES ($1, $2, 'PROXY_SUSPECTED', 'LECTURER', $3) RETURNING id`,
        [f.courseId, attendanceId, f.lecturerId],
      );
      await c.query(
        `INSERT INTO investigation_flag_events (flag_id, event_no, from_state, to_state, actor_user_id)
         VALUES ($1, 1, NULL, 'OPEN', $2)`,
        [rows[0]?.id, f.lecturerId],
      );
    });

    const { rows } = await db.pool.query<{ status: string; current_rev_no: number }>(
      'SELECT status, current_rev_no FROM attendance_records WHERE id = $1',
      [attendanceId],
    );
    expect(rows[0]).toEqual({ status: 'PRESENT', current_rev_no: 1 });
  });

  it('forbids a second active flag of the same kind on the same attendance record', async () => {
    const f = await createFixture(db.pool);
    const sessionId = await createSession(db.pool, f.courseId, f.lecturerId, 'CHECK_IN_OPEN');
    const attendanceId = await createAttendance(db.pool, f, sessionId);
    const raise = () =>
      tx(db.pool, async (c) => {
        const { rows } = await c.query<{ id: string }>(
          `INSERT INTO investigation_flags (course_id, attendance_id, kind, origin, raised_by)
           VALUES ($1, $2, 'PROXY_SUSPECTED', 'LECTURER', $3) RETURNING id`,
          [f.courseId, attendanceId, f.lecturerId],
        );
        await c.query(
          `INSERT INTO investigation_flag_events (flag_id, event_no, from_state, to_state, actor_user_id)
           VALUES ($1, 1, NULL, 'OPEN', $2)`,
          [rows[0]?.id, f.lecturerId],
        );
      });
    await raise();
    await expect(raise()).rejects.toMatchObject({
      code: '23505',
      constraint: 'flags_active_attendance_key',
    });
  });
});

describe('restrictive deletion preserves history', () => {
  it('refuses to delete a user referenced by attendance', async () => {
    const f = await createFixture(db.pool);
    const sessionId = await createSession(db.pool, f.courseId, f.lecturerId, 'CHECK_IN_OPEN');
    await createAttendance(db.pool, f, sessionId);
    await expect(
      db.pool.query('DELETE FROM users WHERE id = $1', [f.studentId]),
    ).rejects.toMatchObject({
      code: '23503',
    });
  });
});

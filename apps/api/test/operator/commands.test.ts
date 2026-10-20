import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  assignLecturer,
  createCourse,
  createLecturer,
  createTerm,
  endAssignment,
  OperatorError,
  releaseStudentId,
} from '../../src/operator/commands.js';
import {
  createTestApp,
  get,
  newRegistration,
  post,
  registerBody,
  cookieHeader,
  type TestApp,
} from '../helpers/app.js';
import { createMigratedTestDatabase, type MigratedTestDatabase } from '../helpers/testDb.js';

let db: MigratedTestDatabase;
let t: TestApp;
const operator = 'test-operator';

beforeAll(async () => {
  db = await createMigratedTestDatabase();
  t = await createTestApp(db);
});

afterAll(async () => {
  await t?.close();
  await db?.drop();
});

const audit = async (action: string) =>
  (
    await db.pool.query<{
      actor_type: string;
      class: string;
      retain_until: string;
      summary: { operator?: string };
    }>(
      `SELECT actor_type, class, to_char(retain_until, 'YYYY-MM-DD') AS retain_until, summary
         FROM audit_events WHERE action = $1`,
      [action],
    )
  ).rows;

describe('operator provisioning (no administrator dashboard)', () => {
  it('creates terms, courses, lecturers and assignments, each with an audit event', async () => {
    await createTerm(db.operatorPool, {
      operator,
      name: 'Autumn 2026',
      startsOn: '2026-09-01',
      endsOn: '2026-12-20',
    });
    await createCourse(db.operatorPool, {
      operator,
      term: 'Autumn 2026',
      code: 'CS101',
      title: 'Intro to CS',
    });
    const lecturer = await createLecturer(db.operatorPool, {
      operator,
      email: 'Prof.Mensah@School.test',
      fullName: 'Prof Mensah',
    });
    const result = await assignLecturer(db.operatorPool, {
      operator,
      term: 'Autumn 2026',
      courseCode: 'CS101',
      lecturerEmail: 'prof.mensah@school.test',
    });
    expect(result.reactivated).toBe(false);
    expect(lecturer.temporaryPassword.length).toBeGreaterThanOrEqual(20);

    for (const action of [
      'TERM_CREATED',
      'COURSE_CREATED',
      'LECTURER_CREATED',
      'LECTURER_ASSIGNED',
    ]) {
      const rows = await audit(action);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.actor_type).toBe('OPERATOR');
      expect(rows[0]?.summary.operator).toBe(operator);
    }
  });

  it('retains course-related audit events until term end + 1 year', async () => {
    const rows = await audit('COURSE_CREATED');
    expect(rows[0]?.class).toBe('DOMAIN');
    expect(rows[0]?.retain_until).toBe('2027-12-20'); // term ends 2026-12-20, plus one year
  });

  it('produces a lecturer who can sign in with the temporary password, and only as a lecturer', async () => {
    const lecturer = await createLecturer(db.operatorPool, {
      operator,
      email: 'dr.owusu@school.test',
      fullName: 'Dr Owusu',
    });
    const res = await post(t.app, '/auth/login', {
      email: 'dr.owusu@school.test',
      password: lecturer.temporaryPassword,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().user).toMatchObject({ role: 'LECTURER', emailVerified: true });
    const me = await get(t.app, '/auth/me', { cookie: cookieHeader(res) });
    expect(me.json().user.fullName).toBe('Dr Owusu');
    // Lecturer sessions are short (2 h idle / 12 h absolute).
    const { rows } = await db.pool.query<{ idle_h: number; abs_h: number }>(
      `SELECT round(extract(epoch FROM (idle_expires_at - created_at)) / 3600)::int AS idle_h,
              round(extract(epoch FROM (absolute_expires_at - created_at)) / 3600)::int AS abs_h
         FROM auth_sessions WHERE user_id = $1`,
      [lecturer.id],
    );
    expect(rows[0]).toEqual({ idle_h: 2, abs_h: 12 });
  });

  it('stores only a hash of the temporary password', async () => {
    const lecturer = await createLecturer(db.operatorPool, {
      operator,
      email: 'hash.check@school.test',
      fullName: 'Hash Check',
    });
    const { rows } = await db.pool.query<{ password_hash: string }>(
      'SELECT password_hash FROM users WHERE id = $1',
      [lecturer.id],
    );
    expect(rows[0]?.password_hash.startsWith('$argon2id$')).toBe(true);
    expect(rows[0]?.password_hash).not.toContain(lecturer.temporaryPassword);
  });

  it('rejects duplicates and bad input with clear operator errors', async () => {
    await expect(
      createTerm(db.operatorPool, {
        operator,
        name: 'Autumn 2026',
        startsOn: '2026-09-01',
        endsOn: '2026-12-20',
      }),
    ).rejects.toBeInstanceOf(OperatorError);
    await expect(
      createTerm(db.operatorPool, {
        operator,
        name: 'Bad',
        startsOn: '2026-12-20',
        endsOn: '2026-09-01',
      }),
    ).rejects.toThrow(/end after/);
    await expect(
      createCourse(db.operatorPool, {
        operator,
        term: 'Autumn 2026',
        code: 'CS101',
        title: 'Again',
      }),
    ).rejects.toThrow(/already exists/);
    await expect(
      createCourse(db.operatorPool, { operator, term: 'No such term', code: 'X', title: 'X' }),
    ).rejects.toThrow(/No term/);
    await expect(
      createLecturer(db.operatorPool, {
        operator,
        email: 'prof.mensah@school.test',
        fullName: 'Dup',
      }),
    ).rejects.toThrow(/already exists/);
    await expect(
      assignLecturer(db.operatorPool, {
        operator,
        term: 'Autumn 2026',
        courseCode: 'CS101',
        lecturerEmail: 'prof.mensah@school.test',
      }),
    ).rejects.toThrow(/already assigned/);
    await expect(
      assignLecturer(db.operatorPool, {
        operator,
        term: 'Autumn 2026',
        courseCode: 'CS101',
        lecturerEmail: 'nobody@school.test',
      }),
    ).rejects.toThrow(/No lecturer/);
  });

  it('refuses to assign a student account as a lecturer', async () => {
    await post(t.app, '/auth/register/commit', {
      studentId: 'STU900001',
      fullName: 'Kofi Student',
      email: 'kofi@school.test',
      password: 'a-long-enough-password',
      confirmed: true,
    });
    await expect(
      assignLecturer(db.operatorPool, {
        operator,
        term: 'Autumn 2026',
        courseCode: 'CS101',
        lecturerEmail: 'kofi@school.test',
      }),
    ).rejects.toThrow(/No lecturer/);
  });

  it('ends an assignment without deleting history, and can reactivate it', async () => {
    await endAssignment(db.operatorPool, {
      operator,
      term: 'Autumn 2026',
      courseCode: 'CS101',
      lecturerEmail: 'prof.mensah@school.test',
    });
    const { rows } = await db.pool.query<{ ended_at: Date | null }>(
      'SELECT ended_at FROM lecturer_courses',
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.ended_at).not.toBeNull();
    await expect(
      endAssignment(db.operatorPool, {
        operator,
        term: 'Autumn 2026',
        courseCode: 'CS101',
        lecturerEmail: 'prof.mensah@school.test',
      }),
    ).rejects.toThrow(/No active assignment/);

    const again = await assignLecturer(db.operatorPool, {
      operator,
      term: 'Autumn 2026',
      courseCode: 'CS101',
      lecturerEmail: 'prof.mensah@school.test',
    });
    expect(again.reactivated).toBe(true);
    expect(await audit('LECTURER_ASSIGNMENT_ENDED')).toHaveLength(1);
    expect(await audit('LECTURER_ASSIGNMENT_REACTIVATED')).toHaveLength(1);
  });

  it('keeps the operator role narrow: it cannot touch attendance, sessions or history', async () => {
    for (const sql of [
      'SELECT * FROM attendance_records',
      'SELECT * FROM class_sessions',
      'DELETE FROM audit_events',
      `UPDATE users SET role = 'STUDENT'`,
      'DELETE FROM courses',
    ]) {
      await expect(db.operatorPool.query(sql)).rejects.toMatchObject({ code: '42501' });
    }
  });

  it('is the only path to courses and assignments: the application role cannot create courses, assign lecturers or pre-verify accounts', async () => {
    const insertUser = (cols: string, vals: string) =>
      db.appPool.query(`INSERT INTO users (${cols}) VALUES (${vals})`);
    await expect(
      insertUser(
        'email, full_name, password_hash, email_verified_at',
        `'pre@school.test', 'Pre Verified', 'x', now()`,
      ),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(
      db.appPool.query(
        `INSERT INTO courses (term_id, code, title) SELECT id, 'HACK', 'Hack' FROM terms LIMIT 1`,
      ),
    ).rejects.toMatchObject({ code: '42501' });
    // Without a role the default applies, and student accounts also need a student ID.
    await expect(
      insertUser('email, full_name, password_hash', `'norole@school.test', 'No Role', 'x'`),
    ).rejects.toMatchObject({
      code: '23514',
      constraint: 'users_student_id_iff_student',
    });
  });
});

describe('release-student-id frees a stuck student ID', () => {
  it('retires the held account, tombstones its ID, and lets the ID register again', async () => {
    const reg = newRegistration({ studentId: 'REL000001' });
    expect((await post(t.app, '/auth/register/commit', registerBody(reg))).statusCode).toBe(201);

    // The ID is taken: a second registration with it is rejected.
    const dup = newRegistration({ studentId: 'REL000001' });
    expect((await post(t.app, '/auth/register/commit', registerBody(dup))).statusCode).toBe(409);

    const { accountId } = await releaseStudentId(db.operatorPool, {
      operator,
      studentId: 'REL000001',
    });
    const held = (
      await db.pool.query<{ student_id_norm: string; status: string }>(
        `SELECT student_id_norm, status FROM users WHERE id = $1`,
        [accountId],
      )
    ).rows[0]!;
    expect(held.status).toBe('DISABLED');
    expect(held.student_id_norm.startsWith('RELEASED:')).toBe(true);

    // The real ID is now free: a fresh registration succeeds.
    const fresh = newRegistration({ studentId: 'REL000001' });
    expect((await post(t.app, '/auth/register/commit', registerBody(fresh))).statusCode).toBe(201);
  });

  it('rejects an ID that no account holds', async () => {
    await expect(
      releaseStudentId(db.operatorPool, { operator, studentId: 'NOBODY-HAS-THIS' }),
    ).rejects.toBeInstanceOf(OperatorError);
  });
});

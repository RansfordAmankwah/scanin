import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  cookieHeader,
  createTestApp,
  freshIp,
  get,
  newRegistration,
  post,
  registerAndLogin,
  registerBody,
  type TestApp,
} from '../helpers/app.js';
import { createCourse, createTerm } from '../helpers/seed.js';
import { createMigratedTestDatabase, type MigratedTestDatabase } from '../helpers/testDb.js';

let db: MigratedTestDatabase;
let t: TestApp;
let courseId: string;
let seq = 0;

beforeAll(async () => {
  db = await createMigratedTestDatabase();
  t = await createTestApp(db);
  courseId = await createCourse(db.pool, await createTerm(db.pool));
});

afterAll(async () => {
  await t.close();
  await db.drop();
});

const lecturer = () => {
  seq += 1;
  return {
    fullName: 'Dr Kofi Boateng',
    email: `lecturer${seq}@school.test`,
    password: 'a-long-lecturer-pass-1',
  };
};

async function signUpAndLogin() {
  const body = lecturer();
  const created = await post(t.app, '/auth/register/lecturer', body);
  expect(created.statusCode).toBe(201);
  const login = await post(t.app, '/auth/login', { email: body.email, password: body.password });
  expect(login.statusCode).toBe(200);
  return { body, cookie: cookieHeader(login) };
}

describe('lecturer self-registration', () => {
  it('creates a LECTURER account with no student ID, unverified, and sends the verification e-mail', async () => {
    const body = lecturer();
    const res = await post(t.app, '/auth/register/lecturer', body);
    expect(res.statusCode).toBe(201);

    const { rows } = await db.pool.query(
      `SELECT role, student_id_norm, student_id_display, email_verified_at, status, full_name
         FROM users WHERE email = $1`,
      [body.email],
    );
    expect(rows).toEqual([
      {
        role: 'LECTURER',
        student_id_norm: null,
        student_id_display: null,
        email_verified_at: null,
        status: 'ACTIVE',
        full_name: 'Dr Kofi Boateng',
      },
    ]);
    expect(t.mailer.outbox.some((m) => m.to === body.email)).toBe(true);

    const audit = await db.pool.query(
      `SELECT actor_type FROM audit_events
        WHERE action = 'ACCOUNT_REGISTERED'
          AND actor_user_id = (SELECT id FROM users WHERE email = $1)`,
      [body.email],
    );
    expect(audit.rows).toEqual([{ actor_type: 'LECTURER' }]);
  });

  it('can sign in without verifying the e-mail, and is a lecturer', async () => {
    const { cookie } = await signUpAndLogin();
    const me = await get(t.app, '/auth/me', { cookie });
    expect(me.json().user).toMatchObject({ role: 'LECTURER', emailVerified: false });
  });

  it('stores only a hash of the password', async () => {
    const { body } = await signUpAndLogin();
    const { rows } = await db.pool.query('SELECT password_hash FROM users WHERE email = $1', [
      body.email,
    ]);
    expect(rows[0].password_hash).toMatch(/^\$argon2id\$/);
    expect(rows[0].password_hash).not.toContain(body.password);
  });

  it('refuses bad input without creating anything', async () => {
    const before = (await db.pool.query('SELECT count(*)::int AS n FROM users')).rows[0].n;
    const cases = [
      { ...lecturer(), password: 'short' },
      { ...lecturer(), email: 'not-an-email' },
      { ...lecturer(), fullName: '   ' },
      { email: 'x@school.test', password: 'a-long-lecturer-pass-1' },
    ];
    for (const c of cases) {
      const res = await post(t.app, '/auth/register/lecturer', c);
      expect(res.statusCode, JSON.stringify(c)).toBe(400);
    }
    const after = (await db.pool.query('SELECT count(*)::int AS n FROM users')).rows[0].n;
    expect(after).toBe(before);
  });

  it('answers a duplicate e-mail exactly like success, and creates no second account', async () => {
    const body = lecturer();
    expect((await post(t.app, '/auth/register/lecturer', body)).statusCode).toBe(201);
    const again = await post(t.app, '/auth/register/lecturer', body);
    expect(again.statusCode).toBe(201);
    const { rows } = await db.pool.query('SELECT count(*)::int AS n FROM users WHERE email = $1', [
      body.email,
    ]);
    expect(rows[0].n).toBe(1);
  });

  it('requires the same-origin headers (CSRF)', async () => {
    const res = await post(t.app, '/auth/register/lecturer', lecturer(), { noCsrf: true });
    expect(res.statusCode).toBe(403);
  });

  it('shares the per-IP registration limit', async () => {
    const ip = freshIp();
    let last = 0;
    for (let i = 0; i < 12; i++) {
      last = (await post(t.app, '/auth/register/lecturer', lecturer(), { ip })).statusCode;
    }
    expect(last).toBe(429);
  });
});

describe('a lecturer with no assigned course has no access to anything', () => {
  it('sees an empty course list', async () => {
    const { cookie } = await signUpAndLogin();
    const res = await get(t.app, '/courses', { cookie });
    expect(res.statusCode).toBe(200);
    expect(res.json().courses).toEqual([]);
  });

  it('is refused on every course-scoped route of an existing course, and creates nothing', async () => {
    const { cookie } = await signUpAndLogin();
    const base = `/courses/${courseId}`;
    for (const url of [base, `${base}/sessions`, `${base}/exports`]) {
      const res = await get(t.app, url, { cookie });
      expect([403, 404], url).toContain(res.statusCode);
    }
    const create = await post(t.app, `${base}/sessions`, { title: 'Hijack' }, { cookie });
    expect([403, 404]).toContain(create.statusCode);
    const { rows } = await db.pool.query(
      'SELECT count(*)::int AS n FROM class_sessions WHERE course_id = $1',
      [courseId],
    );
    expect(rows[0].n).toBe(0);
  });

  it('cannot assign themselves a course (database refuses), nor check in as a student', async () => {
    const { cookie } = await signUpAndLogin();
    await expect(
      db.appPool.query(
        `INSERT INTO lecturer_courses (course_id, lecturer_id)
         SELECT $1, id FROM users WHERE role = 'LECTURER' LIMIT 1`,
        [courseId],
      ),
    ).rejects.toMatchObject({ code: '42501' });
    const checkin = await post(
      t.app,
      '/checkins',
      { token: 'ST1.k1.x.y', clientAttemptId: '11111111-1111-4111-8111-111111111111' },
      { cookie },
    );
    expect(checkin.statusCode).toBe(403);
  });
});

describe('student registration cannot be used to become a lecturer', () => {
  it('ignores a role sent in the student sign-up body', async () => {
    const reg = newRegistration();
    const res = await post(t.app, '/auth/register/commit', {
      ...registerBody(reg),
      role: 'LECTURER',
    });
    expect(res.statusCode).toBe(201);
    const { rows } = await db.pool.query('SELECT role FROM users WHERE email = $1', [reg.email]);
    expect(rows[0].role).toBe('STUDENT');
  });

  it('students still sign up and sign in as before', async () => {
    const { cookie } = await registerAndLogin(t.app);
    const me = await get(t.app, '/auth/me', { cookie });
    expect(me.json().user.role).toBe('STUDENT');
  });
});

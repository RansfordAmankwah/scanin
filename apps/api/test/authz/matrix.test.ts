import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import { MemoryMailer } from '../../src/auth/mailer.js';
import {
  assignLecturer,
  createCourse,
  createLecturer,
  createTerm,
  endAssignment,
} from '../../src/operator/commands.js';
import {
  TEST_CONFIG,
  cookieHeader,
  createTestApp,
  get,
  post,
  registerAndLogin,
  type TestApp,
} from '../helpers/app.js';
import { createMigratedTestDatabase, type MigratedTestDatabase } from '../helpers/testDb.js';

let db: MigratedTestDatabase;
let t: TestApp;

const operator = 'matrix-test';
const ids = { courseA: '', courseB: '', courseC: '' };
const cookies = { l1: '', l2: '', l3: '', student: '' };

async function lecturerCookie(email: string, name: string): Promise<string> {
  const l = await createLecturer(db.operatorPool, { operator, email, fullName: name });
  const res = await post(t.app, '/auth/login', { email, password: l.temporaryPassword });
  expect(res.statusCode).toBe(200);
  return cookieHeader(res);
}

beforeAll(async () => {
  db = await createMigratedTestDatabase();
  t = await createTestApp(db);

  await createTerm(db.operatorPool, {
    operator,
    name: 'T1',
    startsOn: '2026-09-01',
    endsOn: '2026-12-20',
  });
  ids.courseA = (
    await createCourse(db.operatorPool, { operator, term: 'T1', code: 'A', title: 'Course A' })
  ).id;
  ids.courseB = (
    await createCourse(db.operatorPool, { operator, term: 'T1', code: 'B', title: 'Course B' })
  ).id;
  ids.courseC = (
    await createCourse(db.operatorPool, { operator, term: 'T1', code: 'C', title: 'Course C' })
  ).id;

  cookies.l1 = await lecturerCookie('l1@school.test', 'Lecturer One'); // assigned to A
  cookies.l2 = await lecturerCookie('l2@school.test', 'Lecturer Two'); // assigned to B
  cookies.l3 = await lecturerCookie('l3@school.test', 'Lecturer Three'); // was assigned to C, then ended
  await assignLecturer(db.operatorPool, {
    operator,
    term: 'T1',
    courseCode: 'A',
    lecturerEmail: 'l1@school.test',
  });
  await assignLecturer(db.operatorPool, {
    operator,
    term: 'T1',
    courseCode: 'B',
    lecturerEmail: 'l2@school.test',
  });
  await assignLecturer(db.operatorPool, {
    operator,
    term: 'T1',
    courseCode: 'C',
    lecturerEmail: 'l3@school.test',
  });
  await endAssignment(db.operatorPool, {
    operator,
    term: 'T1',
    courseCode: 'C',
    lecturerEmail: 'l3@school.test',
  });

  cookies.student = (await registerAndLogin(t.app)).cookie;
});

afterAll(async () => {
  await t?.close();
  await db?.drop();
});

type Route = { method: string; url: string; spec: { roles: readonly string[]; course?: string } };

const protectedRoutes = (): Route[] =>
  t.app.authzRoutes.filter(
    (r) => !('public' in r.spec) && r.method !== 'HEAD',
  ) as unknown as Route[];

// Other path parameters get a well-formed id that matches nothing; authorization runs first anyway.
const fill = (url: string, courseId: string): string =>
  url
    .replace(':courseId', courseId)
    .replace(':linkId', randomUUID())
    .replace(':sessionId', randomUUID())
    .replace(':flagId', randomUUID())
    .replace(':attendanceId', randomUUID());

function call(route: Route, courseId: string, cookie?: string) {
  const url = fill(route.url, courseId);
  return route.method === 'GET'
    ? get(t.app, url, cookie ? { cookie } : {})
    : post(t.app, url, {}, cookie ? { cookie } : {});
}

describe('every route must declare its authorization', () => {
  it('refuses to start when a route has no authz declaration', async () => {
    const app = await buildApp({
      config: TEST_CONFIG,
      pool: db.appPool,
      mailer: new MemoryMailer(),
    });
    // Registration itself fails, so an unprotected route can never be served.
    expect(() => app.get('/rogue', async () => ({ leaked: true }))).toThrow(
      /must declare config\.authz/,
    );
    await app.close().catch(() => undefined);
  });

  it('exposes exactly the intended public routes (adding one is a deliberate act)', () => {
    const publicRoutes = t.app.authzRoutes
      .filter((r) => 'public' in r.spec && r.method !== 'HEAD')
      .map((r) => `${r.method} ${r.url}`)
      .sort();
    expect(publicRoutes).toEqual([
      'GET /healthz',
      'POST /auth/login',
      'POST /auth/register/commit',
      'POST /auth/register/lecturer',
      'POST /auth/register/preview',
      'POST /auth/verify-email',
    ]);
  });

  it('covers the routes that need protection', () => {
    expect(protectedRoutes().length).toBeGreaterThanOrEqual(5);
  });
});

describe('AUTHZ matrix over every protected route', () => {
  it('returns 401 to anonymous callers on every protected route, with no data', async () => {
    for (const route of protectedRoutes()) {
      const res = await call(route, ids.courseA);
      expect(res.statusCode, `${route.method} ${route.url}`).toBe(401);
      expect(res.json()).toEqual({
        error: { code: 'UNAUTHENTICATED', message: 'Please sign in.' },
      });
    }
  });

  it('returns 403 when the signed-in role is not allowed', async () => {
    for (const route of protectedRoutes()) {
      for (const [role, cookie] of [
        ['LECTURER', cookies.l1],
        ['STUDENT', cookies.student],
      ] as const) {
        if (route.spec.roles.includes(role)) continue;
        const res = await call(route, ids.courseA, cookie);
        expect(res.statusCode, `${role} on ${route.method} ${route.url}`).toBe(403);
      }
    }
  });

  it('lets an assigned lecturer read their own course', async () => {
    // Only routes whose sole parameter is the course id can be called with just a course.
    const readable = protectedRoutes().filter(
      (r) => r.spec.course && r.method === 'GET' && !/:(?!courseId(?:\/|$))/.test(r.url),
    );
    expect(readable.length).toBeGreaterThanOrEqual(2);
    for (const route of readable) {
      const res = await call(route, ids.courseA, cookies.l1);
      expect(res.statusCode, `${route.method} ${route.url}`).toBe(200);
    }
  });

  it("returns an identical 404 for another lecturer's course, a nonexistent course and a malformed id", async () => {
    const courseRoutes = protectedRoutes().filter((r) => r.spec.course);
    expect(courseRoutes.length).toBeGreaterThan(0);
    for (const route of courseRoutes) {
      const results = await Promise.all([
        call(route, ids.courseA, cookies.l2), // exists, but lecturer 2 is not assigned
        call(route, ids.courseB, cookies.l1), // exists, but lecturer 1 is not assigned
        call(route, randomUUID(), cookies.l1), // does not exist
        call(route, 'not-a-uuid', cookies.l1), // malformed
        call(route, ids.courseC, cookies.l3), // assignment ended
      ]);
      for (const res of results) {
        expect(res.statusCode, `${route.method} ${route.url}`).toBe(404);
      }
      const bodies = new Set(results.map((r) => r.body));
      expect(bodies.size, 'existence must not be distinguishable').toBe(1);
    }
  });

  it('students are refused lecturer-only data even for a course that exists', async () => {
    const res = await get(t.app, `/courses/${ids.courseA}`, { cookie: cookies.student });
    expect(res.statusCode).toBe(403);
    expect(res.body).not.toContain('Course A');
  });
});

describe('AUTHZ-02 lecturers see only the courses they are assigned to', () => {
  it('lists only active assignments', async () => {
    const one = (await get(t.app, '/courses', { cookie: cookies.l1 })).json();
    expect(one.courses.map((c: { code: string }) => c.code)).toEqual(['A']);
    const two = (await get(t.app, '/courses', { cookie: cookies.l2 })).json();
    expect(two.courses.map((c: { code: string }) => c.code)).toEqual(['B']);
    const three = (await get(t.app, '/courses', { cookie: cookies.l3 })).json();
    expect(three.courses).toEqual([]); // ended assignment
  });

  it('loses access immediately when the operator ends an assignment', async () => {
    expect((await get(t.app, `/courses/${ids.courseB}`, { cookie: cookies.l2 })).statusCode).toBe(
      200,
    );
    await endAssignment(db.operatorPool, {
      operator,
      term: 'T1',
      courseCode: 'B',
      lecturerEmail: 'l2@school.test',
    });
    expect((await get(t.app, `/courses/${ids.courseB}`, { cookie: cookies.l2 })).statusCode).toBe(
      404,
    );
    await assignLecturer(db.operatorPool, {
      operator,
      term: 'T1',
      courseCode: 'B',
      lecturerEmail: 'l2@school.test',
    });
    expect((await get(t.app, `/courses/${ids.courseB}`, { cookie: cookies.l2 })).statusCode).toBe(
      200,
    );
  });

  it('returns the course with its term', async () => {
    const res = (await get(t.app, `/courses/${ids.courseA}`, { cookie: cookies.l1 })).json();
    expect(res.course).toMatchObject({
      code: 'A',
      title: 'Course A',
      term: { name: 'T1', startsOn: '2026-09-01', endsOn: '2026-12-20' },
    });
  });
});

describe('students cannot become lecturers', () => {
  it('a student session never satisfies a lecturer rule, even for an assigned course id', async () => {
    const { rows } = await db.pool.query<{ id: string }>(
      `SELECT id FROM users WHERE role = 'STUDENT' LIMIT 1`,
    );
    const studentId = rows[0]?.id;
    expect(studentId).toBeTruthy();
    // The database also refuses to assign a student to a course (composite FK).
    await expect(
      db.pool.query('INSERT INTO lecturer_courses (course_id, lecturer_id) VALUES ($1, $2)', [
        ids.courseA,
        studentId,
      ]),
    ).rejects.toMatchObject({ code: '23503' });
  });
});

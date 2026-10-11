import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createCourse as operatorCreateCourse } from '../../src/operator/commands.js';
import {
  cookieHeader,
  createTestApp,
  get,
  post,
  registerAndLogin,
  type TestApp,
} from '../helpers/app.js';
import { createLecturer, createStudent, createTerm } from '../helpers/seed.js';
import { createMigratedTestDatabase, type MigratedTestDatabase } from '../helpers/testDb.js';

let db: MigratedTestDatabase;
let t: TestApp;
let seq = 0;

beforeAll(async () => {
  db = await createMigratedTestDatabase();
  t = await createTestApp(db);
});

afterAll(async () => {
  await t.close();
  await db.drop();
});

const iso = (daysFromToday: number) => {
  const d = new Date(Date.now() + daysFromToday * 86_400_000);
  return d.toISOString().slice(0, 10);
};

async function lecturer() {
  seq += 1;
  const body = {
    fullName: 'Dr Self Service',
    email: `selfservice${seq}@school.test`,
    password: 'a-long-lecturer-pass-1',
  };
  expect((await post(t.app, '/auth/register/lecturer', body)).statusCode).toBe(201);
  const login = await post(t.app, '/auth/login', { email: body.email, password: body.password });
  const cookie = cookieHeader(login);
  const id = (await get(t.app, '/auth/me', { cookie })).json().user.id as string;
  return { id, cookie };
}

const newTerm = (name = 'Fall 2026') => ({ name, startsOn: iso(-30), endsOn: iso(90) });

const makeCourse = (cookie: string, body: object) => post(t.app, '/courses', body, { cookie });

describe('a lecturer creating their own term and course', () => {
  it('creates both in one step, is assigned to the course, and can run a session in it', async () => {
    const l = await lecturer();
    const res = await makeCourse(l.cookie, {
      code: ' CS101 ',
      title: ' Intro to CS ',
      newTerm: newTerm(),
    });
    expect(res.statusCode).toBe(201);
    const course = res.json().course;
    expect(course).toMatchObject({ code: 'CS101', title: 'Intro to CS' });
    expect(course.term.name).toBe('Fall 2026');

    const list = (await get(t.app, '/courses', { cookie: l.cookie })).json().courses;
    expect(list.map((c: { id: string }) => c.id)).toEqual([course.id]);

    const session = await post(
      t.app,
      `/courses/${course.id}/sessions`,
      { title: 'Week 1' },
      { cookie: l.cookie },
    );
    expect(session.statusCode).toBe(201);
  });

  it('writes audit events, retained until one year after the term ends', async () => {
    const l = await lecturer();
    const term = newTerm('Audit term');
    const res = await makeCourse(l.cookie, { code: 'AUD1', title: 'Audit', newTerm: term });
    const courseId = res.json().course.id as string;
    const { rows } = await db.pool.query(
      `SELECT action, actor_type, to_char(retain_until, 'YYYY-MM-DD') AS until
         FROM audit_events WHERE actor_user_id = $1 AND action IN ('COURSE_CREATED','TERM_CREATED')
        ORDER BY action`,
      [l.id],
    );
    expect(rows.map((r) => r.action)).toEqual(['COURSE_CREATED', 'TERM_CREATED']);
    expect(rows.every((r) => r.actor_type === 'LECTURER')).toBe(true);
    const ends = new Date(term.endsOn);
    ends.setUTCFullYear(ends.getUTCFullYear() + 1);
    expect(rows[0]?.until).toBe(ends.toISOString().slice(0, 10));
    expect(courseId).toBeTruthy();
  });

  it('keeps each lecturer’s courses and terms to themselves, even with the same term name', async () => {
    const a = await lecturer();
    const b = await lecturer();
    const first = await makeCourse(a.cookie, {
      code: 'X1',
      title: 'A course',
      newTerm: newTerm('Shared name'),
    });
    expect(first.statusCode).toBe(201);
    const second = await makeCourse(b.cookie, {
      code: 'X1',
      title: 'Another course',
      newTerm: newTerm('Shared name'),
    });
    expect(second.statusCode).toBe(201); // no clash: terms are private to their creator

    expect((await get(t.app, '/courses', { cookie: b.cookie })).json().courses).toHaveLength(1);
    const seen = await get(t.app, `/courses/${first.json().course.id}`, { cookie: b.cookie });
    expect(seen.statusCode).toBe(404);
    const termsSeenByB = (await get(t.app, '/terms', { cookie: b.cookie })).json().terms;
    expect(termsSeenByB).toHaveLength(1);
  });

  it('refuses a second term with the same name, and leaves no half-created course behind', async () => {
    const l = await lecturer();
    expect(
      (await makeCourse(l.cookie, { code: 'T1', title: 'One', newTerm: newTerm('Dup') }))
        .statusCode,
    ).toBe(201);
    const again = await makeCourse(l.cookie, { code: 'T2', title: 'Two', newTerm: newTerm('Dup') });
    expect(again.statusCode).toBe(409);
    expect(again.json().error.code).toBe('TERM_EXISTS');
    const { rows } = await db.pool.query(
      `SELECT count(*)::int AS n FROM courses c JOIN lecturer_courses lc ON lc.course_id = c.id
        WHERE lc.lecturer_id = $1`,
      [l.id],
    );
    expect(rows[0].n).toBe(1);
  });

  it('reuses their own term for another course, and refuses a duplicate course code', async () => {
    const l = await lecturer();
    const first = await makeCourse(l.cookie, {
      code: 'R1',
      title: 'One',
      newTerm: newTerm('Reuse'),
    });
    const termId = first.json().course.term.id as string;
    expect((await makeCourse(l.cookie, { code: 'R2', title: 'Two', termId })).statusCode).toBe(201);
    const dup = await makeCourse(l.cookie, { code: 'R2', title: 'Three', termId });
    expect(dup.statusCode).toBe(409);
    expect(dup.json().error.code).toBe('COURSE_EXISTS');
  });

  it('can use a term the operator created, but not another lecturer’s term', async () => {
    const shared = await createTerm(db.pool);
    const a = await lecturer();
    const b = await lecturer();
    expect(
      (await makeCourse(a.cookie, { code: 'S1', title: 'Shared', termId: shared })).statusCode,
    ).toBe(201);
    expect(
      (await get(t.app, '/terms', { cookie: a.cookie }))
        .json()
        .terms.map((x: { id: string }) => x.id),
    ).toContain(shared);

    const mine = await makeCourse(a.cookie, {
      code: 'S2',
      title: 'Own',
      newTerm: newTerm('Private'),
    });
    const stolen = await makeCourse(b.cookie, {
      code: 'S3',
      title: 'Nope',
      termId: mine.json().course.term.id,
    });
    expect(stolen.statusCode).toBe(404);
    expect(stolen.json().error.code).toBe('TERM_NOT_FOUND');
  });

  it('refuses bad terms and courses', async () => {
    const l = await lecturer();
    const bad: Array<[string, object]> = [
      ['end before start', { startsOn: iso(10), endsOn: iso(5) }],
      ['longer than 400 days', { startsOn: iso(0), endsOn: iso(401) }],
      ['ends beyond two years', { startsOn: iso(700), endsOn: iso(800) }],
      ['impossible date', { startsOn: '2026-02-31', endsOn: '2026-12-31' }],
      ['blank name', { name: '   ' }],
    ];
    for (const [label, override] of bad) {
      const res = await makeCourse(l.cookie, {
        code: 'B1',
        title: 'Bad',
        newTerm: { ...newTerm(`bad ${label}`), ...override },
      });
      expect(res.statusCode, label).toBe(400);
    }
    const term = newTerm('Fine');
    const cases: object[] = [
      { code: '', title: 'No code', newTerm: term },
      { code: 'C', title: '   ', newTerm: term },
      { code: 'x'.repeat(33), title: 'Long code', newTerm: term },
      { code: 'C', title: 'Both', newTerm: term, termId: '11111111-1111-4111-8111-111111111111' },
      { code: 'C', title: 'Neither' },
    ];
    for (const c of cases) {
      expect((await makeCourse(l.cookie, c)).statusCode, JSON.stringify(c)).toBe(400);
    }
    expect((await get(t.app, '/courses', { cookie: l.cookie })).json().courses).toEqual([]);
  });

  it('is limited to 20 courses an hour', async () => {
    const l = await lecturer();
    const termId = (
      await makeCourse(l.cookie, { code: 'L0', title: 'First', newTerm: newTerm('Limit') })
    ).json().course.term.id as string;
    let last = 0;
    for (let i = 1; i <= 20; i++) {
      last = (await makeCourse(l.cookie, { code: `L${i}`, title: 'Many', termId })).statusCode;
    }
    expect(last).toBe(429);
  });

  it('is refused to students and to signed-out callers', async () => {
    const student = await registerAndLogin(t.app);
    const asStudent = await makeCourse(student.cookie, {
      code: 'ST',
      title: 'Nope',
      newTerm: newTerm('Student term'),
    });
    expect(asStudent.statusCode).toBe(403);
    const anon = await post(t.app, '/courses', { code: 'AN', title: 'Nope', newTerm: newTerm() });
    expect(anon.statusCode).toBe(401);
  });
});

describe('the database keeps this narrow', () => {
  it('gives the application role no direct INSERT on terms, courses or assignments', async () => {
    const term = await createTerm(db.pool);
    const lecturerId = await createLecturer(db.pool);
    for (const sql of [
      `INSERT INTO terms (name, starts_on, ends_on) VALUES ('x', '2026-01-01', '2026-06-01')`,
      `INSERT INTO courses (term_id, code, title) VALUES ('${term}', 'D', 'D')`,
      `INSERT INTO lecturer_courses (course_id, lecturer_id) VALUES (gen_random_uuid(), '${lecturerId}')`,
    ]) {
      await expect(db.appPool.query(sql), sql).rejects.toMatchObject({ code: '42501' });
    }
  });

  it('lets only the application role run the functions, and only for an active lecturer', async () => {
    const studentId = await createStudent(db.pool);
    await expect(
      db.appPool.query(`SELECT create_term_for_lecturer($1, 'x', '2026-01-01', '2026-06-01')`, [
        studentId,
      ]),
    ).rejects.toMatchObject({ code: 'SC001', message: 'NOT_A_LECTURER' });
    for (const pool of [db.retentionPool, db.operatorPool]) {
      await expect(
        pool.query(`SELECT create_term_for_lecturer($1, 'x', '2026-01-01', '2026-06-01')`, [
          studentId,
        ]),
      ).rejects.toMatchObject({ code: '42501' });
    }
  });

  it('does not confuse the operator’s term lookup with lecturer terms of the same name', async () => {
    const l = await lecturer();
    await makeCourse(l.cookie, { code: 'Z1', title: 'Private', newTerm: newTerm('Operator term') });
    await db.pool.query(
      `INSERT INTO terms (name, starts_on, ends_on) VALUES ('Operator term', '2026-09-01', '2026-12-20')`,
    );
    const made = await operatorCreateCourse(db.operatorPool, {
      operator: 'test',
      term: 'Operator term',
      code: 'OP1',
      title: 'Operator course',
    });
    const { rows } = await db.pool.query(
      `SELECT t.created_by FROM courses c JOIN terms t ON t.id = c.term_id WHERE c.id = $1`,
      [made.id],
    );
    expect(rows[0].created_by).toBeNull();
  });
});

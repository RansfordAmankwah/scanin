import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { checkIn } from '../../src/checkin/service.js';
import { assignLecturer, createCourse, createTerm } from '../../src/operator/commands.js';
import { mintToken, parseKeyring, verifyToken } from '../../src/qr/token.js';
import { endSession as endSessionService } from '../../src/sessions/service.js';
import {
  TEST_CONFIG,
  createLecturerSession,
  createTestApp,
  freshIp,
  newRegistration,
  post,
  registerAndLogin,
  registerStudent,
  type TestApp,
} from '../helpers/app.js';
import { createBulkStudents, type BulkStudent } from '../helpers/students.js';
import { createMigratedTestDatabase, type MigratedTestDatabase } from '../helpers/testDb.js';

let db: MigratedTestDatabase;
let t: TestApp;
let lecturer: { id: string; cookie: string };
let courseId: string;
const operator = 'checkin-test';
const keyring = parseKeyring(TEST_CONFIG.QR_KEYS, TEST_CONFIG.QR_ACTIVE_KID);
let courseSeq = 0;

beforeAll(async () => {
  db = await createMigratedTestDatabase();
  t = await createTestApp(db);
  await createTerm(db.operatorPool, {
    operator,
    name: 'T1',
    startsOn: '2026-09-01',
    endsOn: '2026-12-20',
  });
  lecturer = await createLecturerSession(db, t.app, 'lec@school.test');
  courseId = await newCourse();
});

afterAll(async () => {
  await t?.close();
  await db?.drop();
});

async function newCourse(): Promise<string> {
  courseSeq += 1;
  const code = `K${courseSeq}`;
  const { id } = await createCourse(db.operatorPool, {
    operator,
    term: 'T1',
    code,
    title: `Course ${code}`,
  });
  await assignLecturer(db.operatorPool, {
    operator,
    term: 'T1',
    courseCode: code,
    lecturerEmail: 'lec@school.test',
  });
  return id;
}

async function openSession(course = courseId): Promise<string> {
  const created = await post(
    t.app,
    `/courses/${course}/sessions`,
    { title: 'Lecture' },
    { cookie: lecturer.cookie },
  );
  const id = created.json().session.id as string;
  await post(t.app, `/courses/${course}/sessions/${id}/start`, {}, { cookie: lecturer.cookie });
  return id;
}

const newSession = async (course = courseId): Promise<string> =>
  (
    await post(
      t.app,
      `/courses/${course}/sessions`,
      { title: 'Lecture' },
      { cookie: lecturer.cookie },
    )
  ).json().session.id;

const endSession = (id: string, course = courseId) =>
  post(t.app, `/courses/${course}/sessions/${id}/end`, {}, { cookie: lecturer.cookie });

async function dbNowMs(): Promise<number> {
  return Number(
    (
      await db.pool.query<{ ms: string }>(
        `SELECT floor(extract(epoch FROM clock_timestamp())*1000)::bigint AS ms`,
      )
    ).rows[0]!.ms,
  );
}

/** A correctly signed code for a session, issued `ageMs` ago. */
async function codeFor(sessionId: string, ageMs = 0): Promise<string> {
  return mintToken(keyring, sessionId, (await dbNowMs()) - ageMs).token;
}

async function scan(
  cookie: string,
  token: string,
  opts: { attemptId?: string; headers?: Record<string, string>; deviceId?: string | null } = {},
) {
  return post(
    t.app,
    '/checkins',
    {
      token,
      clientAttemptId: opts.attemptId ?? randomUUID(),
      // Every scan is from a different phone unless the test names one; null sends no device id.
      ...(opts.deviceId === null ? {} : { deviceId: opts.deviceId ?? randomUUID() }),
    },
    { cookie, ip: freshIp(), headers: opts.headers ?? {} },
  );
}

let students: BulkStudent[] = [];
let studentCursor = 0;
async function nextStudents(n: number): Promise<BulkStudent[]> {
  if (students.length - studentCursor < n)
    students = students.concat(await createBulkStudents(db, Math.max(n, 40)));
  const out = students.slice(studentCursor, studentCursor + n);
  studentCursor += n;
  return out;
}

const count = async (sql: string, params: unknown[] = []): Promise<number> =>
  (await db.pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM (${sql}) q`, params)).rows[0]!
    .n;

const attendanceFor = (sessionId: string) =>
  count('SELECT 1 FROM attendance_records WHERE session_id = $1', [sessionId]);
const attemptsFor = async (sessionId: string) =>
  (
    await db.pool.query(
      'SELECT outcome::text AS outcome, attendance_id, ip_hash, ua_family, token_jti, token_kid FROM scan_attempts WHERE session_id = $1 ORDER BY received_at',
      [sessionId],
    )
  ).rows;

/** Moves a session's whole window into the past (owner connection; the app cannot do this). */
async function expire(id: string) {
  await db.pool.query('ALTER TABLE class_sessions DISABLE TRIGGER class_sessions_guard_trg');
  await db.pool.query(
    `UPDATE class_sessions SET started_at = now() - interval '40 minutes', check_in_deadline = now() - interval '10 minutes' WHERE id = $1`,
    [id],
  );
  await db.pool.query('ALTER TABLE class_sessions ENABLE TRIGGER class_sessions_guard_trg');
}

describe('a successful check-in', () => {
  it('records attendance, a first revision, a roster link and a scan record, atomically', async () => {
    const sessionId = await openSession();
    const [s] = await nextStudents(1);
    const res = await scan(s!.cookie, await codeFor(sessionId), {
      headers: {
        'user-agent':
          'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
      },
    });

    expect(res.statusCode).toBe(201);
    expect(res.json()).toEqual({
      result: 'RECORDED',
      attendanceStatus: 'PRESENT',
      associationState: 'PROVISIONAL', // the course has no roster: self-reported, not enrollment
      course: { code: expect.stringMatching(/^K\d+$/), title: expect.stringContaining('Course') },
      sessionTitle: 'Lecture',
    });

    const rec = (
      await db.pool.query(
        `SELECT id, status, source, manual_marked_by, current_rev_no, student_id FROM attendance_records WHERE session_id = $1`,
        [sessionId],
      )
    ).rows;
    expect(rec).toHaveLength(1);
    expect(rec[0]).toMatchObject({
      status: 'PRESENT',
      source: 'QR_SCAN',
      manual_marked_by: null,
      current_rev_no: 1,
      student_id: s!.id,
    });
    const rev = (
      await db.pool.query(
        'SELECT rev_no, change_kind, to_status, actor_user_id FROM attendance_revisions WHERE attendance_id = $1',
        [rec[0].id],
      )
    ).rows;
    expect(rev).toEqual([
      { rev_no: 1, change_kind: 'CREATED_QR', to_status: 'PRESENT', actor_user_id: s!.id },
    ]);

    const attempts = await attemptsFor(sessionId);
    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatchObject({
      outcome: 'ACCEPTED',
      attendance_id: rec[0].id,
      ua_family: 'Safari',
      token_kid: 'k1',
    });
    expect(attempts[0].ip_hash.length).toBe(16); // hashed, never the address itself
    expect(attempts[0].token_jti).toMatch(/^[0-9a-f]{32}$/);

    expect(
      await count(`SELECT 1 FROM roster_links WHERE course_id = $1 AND student_id = $2`, [
        courseId,
        s!.id,
      ]),
    ).toBe(1);
    expect(
      await count(
        `SELECT 1 FROM audit_events WHERE action = 'ROSTER_LINK_CREATED' AND course_id = $1`,
        [courseId],
      ),
    ).toBeGreaterThan(0);
  });

  it('confirms the association by roster ID match and says so', async () => {
    const course = await newCourse();
    const sessionId = await openSession(course);
    const reg = newRegistration({ studentId: 'ROSTER-ID-1' });
    await registerStudent(db, t, reg);
    const login = await post(t.app, '/auth/login', { email: reg.email, password: reg.password });
    const preview = await post(
      t.app,
      `/courses/${course}/roster/preview`,
      { csv: 'student_id,full_name\nROSTER-ID-1,Ama Mensah\n' },
      { cookie: lecturer.cookie },
    );
    await post(
      t.app,
      `/courses/${course}/roster/apply`,
      {
        csv: 'student_id,full_name\nROSTER-ID-1,Ama Mensah\n',
        previewToken: preview.json().previewToken,
        retireEntryIds: [],
      },
      { cookie: lecturer.cookie },
    );

    const res = await scan(
      `${login.cookies[0]!.name}=${login.cookies[0]!.value}`,
      await codeFor(sessionId),
    );
    expect(res.statusCode).toBe(201);
    expect(res.json().associationState).toBe('CONFIRMED');
  });

  it('never exposes flags, lecturer notes or other students in the response', async () => {
    const sessionId = await openSession();
    const [s] = await nextStudents(1);
    const body = (await scan(s!.cookie, await codeFor(sessionId))).body;
    for (const forbidden of ['flag', 'explanation', 'reason', 'ip_hash', 'jti', 'ST1.'])
      expect(body.toLowerCase()).not.toContain(forbidden.toLowerCase());
  });
});

describe('QR-05 a valid code does not authorise check-in unless the session is open', () => {
  it('rejects a valid code for a session that has not started', async () => {
    const sessionId = await newSession();
    const [s] = await nextStudents(1);
    const res = await scan(s!.cookie, await codeFor(sessionId));
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('SESSION_NOT_STARTED');
    expect(await attendanceFor(sessionId)).toBe(0);
    expect((await attemptsFor(sessionId)).map((a) => a.outcome)).toEqual([
      'REJECTED_SESSION_NOT_STARTED',
    ]);
  });

  it('rejects a valid code after the deadline, even before the sweeper has run', async () => {
    const sessionId = await openSession();
    const token = await codeFor(sessionId);
    await expire(sessionId);
    const [s] = await nextStudents(1);
    const res = await scan(s!.cookie, token);
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('SESSION_CLOSED');
    expect(await attendanceFor(sessionId)).toBe(0);
    expect((await attemptsFor(sessionId))[0]!.outcome).toBe('REJECTED_SESSION_CLOSED');
  });

  it('rejects a valid code once the lecturer has ended the session', async () => {
    const sessionId = await openSession();
    const token = await codeFor(sessionId);
    const [a, b] = await nextStudents(2);
    expect((await scan(a!.cookie, token)).statusCode).toBe(201);
    await endSession(sessionId);
    const res = await scan(b!.cookie, token);
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('SESSION_ENDED');
    expect(await attendanceFor(sessionId)).toBe(1);
  });

  it('still accepts a code while the deadline has been extended', async () => {
    const sessionId = await openSession();
    const view = await post(
      t.app,
      `/courses/${courseId}/sessions/${sessionId}/extend`,
      {
        minutes: 5,
        reason: 'Overran',
        expectedDeadline: (
          await (
            await import('../helpers/app.js')
          ).get(t.app, `/courses/${courseId}/sessions/${sessionId}`, { cookie: lecturer.cookie })
        ).json().session.checkInDeadline,
      },
      { cookie: lecturer.cookie },
    );
    expect(view.statusCode).toBe(200);
    const [s] = await nextStudents(1);
    expect((await scan(s!.cookie, await codeFor(sessionId))).statusCode).toBe(201);
  });
});

describe('QR-02 / QR-07 code lifetime and revocation, end to end', () => {
  it('accepts a code issued just under three minutes ago and rejects one just over', async () => {
    const sessionId = await openSession();
    const [a, b] = await nextStudents(2);
    expect((await scan(a!.cookie, await codeFor(sessionId, 170_000))).statusCode).toBe(201);
    const res = await scan(b!.cookie, await codeFor(sessionId, 181_000));
    expect(res.statusCode).toBe(410);
    expect(res.json().error.code).toBe('CODE_EXPIRED');
    expect((await attemptsFor(sessionId)).map((x) => x.outcome)).toEqual([
      'ACCEPTED',
      'REJECTED_TOKEN_EXPIRED',
    ]);
    expect(await attendanceFor(sessionId)).toBe(1);
  });

  it('rejects codes issued before the lecturer invalidated them, and accepts newer ones', async () => {
    const sessionId = await openSession();
    const before = await post(
      t.app,
      `/courses/${courseId}/sessions/${sessionId}/qr/invalidate`,
      {},
      { cookie: lecturer.cookie },
    );
    expect(before.statusCode).toBe(200);
    const [a, b, c] = await nextStudents(3);
    const stale = await codeFor(sessionId, 5_000); // issued before the mark
    await new Promise((r) => setTimeout(r, 15));
    const fresh = await codeFor(sessionId);

    const rejected = await scan(a!.cookie, stale);
    expect(rejected.statusCode).toBe(410);
    expect(rejected.json().error.code).toBe('CODE_REVOKED');
    expect((await scan(b!.cookie, fresh)).statusCode).toBe(201);
    // The window itself was untouched by the invalidation.
    expect((await scan(c!.cookie, fresh)).statusCode).toBe(201);
    expect((await attemptsFor(sessionId)).map((x) => x.outcome)).toEqual([
      'REJECTED_TOKEN_REVOKED',
      'ACCEPTED',
      'ACCEPTED',
    ]);
  });
});

describe('QR-01 forged or malformed codes never reach the database', () => {
  it('answers 400 INVALID_CODE, records only a security event, and never echoes the code', async () => {
    const sessionId = await openSession();
    const good = await codeFor(sessionId);
    const [s] = await nextStudents(1);
    const parts = good.split('.');
    const tampered = [parts[0], parts[1], parts[2], `${parts[3]!.slice(0, -2)}AA`].join('.');
    const otherKeys = mintToken(
      parseKeyring(`k1:${'D'.repeat(43)}`, 'k1'),
      sessionId,
      await dbNowMs(),
    ).token;
    const before = await count(`SELECT 1 FROM audit_events WHERE action = 'QR_CODE_REJECTED'`);

    for (const bad of [tampered, otherKeys, 'ST1.k1.abc.def', 'not a code', '']) {
      const res = await scan(s!.cookie, bad);
      if (bad === '')
        expect(res.statusCode).toBe(400); // fails validation before reaching the checks
      else {
        expect(res.statusCode).toBe(400);
        expect(res.json().error.code).toBe('INVALID_CODE');
      }
      expect(res.body).not.toContain(bad || '\u0000');
    }
    expect(await attendanceFor(sessionId)).toBe(0);
    expect(await attemptsFor(sessionId)).toHaveLength(0);
    expect(await count(`SELECT 1 FROM audit_events WHERE action = 'QR_CODE_REJECTED'`)).toBe(
      before + 4,
    );
    const event = (
      await db.pool.query(
        `SELECT summary, actor_type, outcome::text AS outcome FROM audit_events WHERE action = 'QR_CODE_REJECTED' ORDER BY id DESC LIMIT 1`,
      )
    ).rows[0];
    expect(event.summary).toEqual({
      reason: expect.stringMatching(/MALFORMED|BAD_SIGNATURE|UNKNOWN_KEY/),
    });
    expect(event.outcome).toBe('DENIED');
  });

  it('treats a correctly signed code for a session that does not exist as invalid', async () => {
    const [s] = await nextStudents(1);
    const res = await scan(s!.cookie, await codeFor(randomUUID()));
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('INVALID_CODE');
  });

  it('refuses requests that are not from a signed-in student', async () => {
    const sessionId = await openSession();
    const token = await codeFor(sessionId);
    expect(
      (await post(t.app, '/checkins', { token, clientAttemptId: randomUUID() })).statusCode,
    ).toBe(401);
    expect(
      (
        await post(
          t.app,
          '/checkins',
          { token, clientAttemptId: randomUUID() },
          { cookie: lecturer.cookie },
        )
      ).statusCode,
    ).toBe(403);
    expect(await attendanceFor(sessionId)).toBe(0);
  });

  it('validates the request body', async () => {
    const [s] = await nextStudents(1);
    for (const body of [
      {},
      { token: 'x' },
      { clientAttemptId: randomUUID() },
      { token: 'x', clientAttemptId: 'nope' },
    ]) {
      expect((await post(t.app, '/checkins', body, { cookie: s!.cookie })).statusCode).toBe(400);
    }
  });

  it('can only ever check in the signed-in student, whatever the body says', async () => {
    const sessionId = await openSession();
    const [me, other] = await nextStudents(2);
    const res = await post(
      t.app,
      '/checkins',
      {
        token: await codeFor(sessionId),
        clientAttemptId: randomUUID(),
        deviceId: randomUUID(),
        studentId: other!.id,
        userId: other!.id,
      },
      { cookie: me!.cookie, ip: freshIp() },
    );
    expect(res.statusCode).toBe(201);
    const rows = (
      await db.pool.query('SELECT student_id FROM attendance_records WHERE session_id = $1', [
        sessionId,
      ])
    ).rows;
    expect(rows).toEqual([{ student_id: me!.id }]);
  });
});

describe('QR-03 one code serves a whole class', () => {
  it('lets 25 different students scan the same code, and it stays valid afterwards', async () => {
    const sessionId = await openSession();
    const token = await codeFor(sessionId);
    const group = await nextStudents(25);
    const results = await Promise.all(group.map((s) => scan(s.cookie, token)));
    expect(results.map((r) => r.statusCode)).toEqual(Array(25).fill(201));
    expect(await attendanceFor(sessionId)).toBe(25);

    const [late] = await nextStudents(1);
    expect((await scan(late!.cookie, token)).statusCode).toBe(201); // not consumed
    const jtis = new Set((await attemptsFor(sessionId)).map((a) => a.token_jti));
    expect(jtis.size).toBe(1);
    expect(verifyToken(keyring, token).ok).toBe(true);
  });
});

describe('duplicates return the existing result and create nothing', () => {
  it('a repeat scan with a new attempt id is ALREADY_RECORDED, even after the class has ended', async () => {
    const sessionId = await openSession();
    const [s] = await nextStudents(1);
    const first = await scan(s!.cookie, await codeFor(sessionId));
    const second = await scan(s!.cookie, await codeFor(sessionId));
    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(200);
    expect(second.json().result).toBe('ALREADY_RECORDED');

    await endSession(sessionId);
    const third = await scan(s!.cookie, await codeFor(sessionId));
    expect(third.statusCode).toBe(200);
    expect(third.json().result).toBe('ALREADY_RECORDED');

    expect(await attendanceFor(sessionId)).toBe(1);
    expect(
      await count(
        'SELECT 1 FROM attendance_revisions r JOIN attendance_records a ON a.id = r.attendance_id WHERE a.session_id = $1',
        [sessionId],
      ),
    ).toBe(1);
    expect((await attemptsFor(sessionId)).map((a) => a.outcome)).toEqual([
      'ACCEPTED',
      'DUPLICATE_EXISTING',
      'DUPLICATE_EXISTING',
    ]);
  });

  it('reports a lecturer-invalidated record as such, without recreating or restoring it', async () => {
    const sessionId = await openSession();
    const [s] = await nextStudents(1);
    await scan(s!.cookie, await codeFor(sessionId));
    const id = (
      await db.pool.query('SELECT id FROM attendance_records WHERE session_id = $1', [sessionId])
    ).rows[0].id;
    await db.pool.query('BEGIN');
    await db.pool.query(
      `INSERT INTO attendance_revisions (attendance_id, rev_no, change_kind, from_status, to_status, actor_user_id, reason_category, explanation) VALUES ($1, 2, 'INVALIDATED', 'PRESENT', 'INVALIDATED', $2, 'OTHER', 'Marked by mistake in test')`,
      [id, lecturer.id],
    );
    await db.pool.query(
      `UPDATE attendance_records SET status = 'INVALIDATED', current_rev_no = 2 WHERE id = $1`,
      [id],
    );
    await db.pool.query('COMMIT');

    const res = await scan(s!.cookie, await codeFor(sessionId));
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      result: 'ALREADY_RECORDED',
      attendanceStatus: 'INVALIDATED',
    });
    expect(
      (
        await db.pool.query('SELECT status, current_rev_no FROM attendance_records WHERE id = $1', [
          id,
        ])
      ).rows[0],
    ).toEqual({ status: 'INVALIDATED', current_rev_no: 2 });
    expect(res.body).not.toContain('mistake'); // the lecturer's explanation is never shown
  });

  it('replays an earlier attempt id: the same answer, no new rows, even after the window closes', async () => {
    const sessionId = await openSession();
    const [s] = await nextStudents(1);
    const token = await codeFor(sessionId);
    const attemptId = randomUUID();
    const first = await scan(s!.cookie, token, { attemptId });
    await endSession(sessionId);
    const retry = await scan(s!.cookie, token, { attemptId });

    expect(first.statusCode).toBe(201);
    expect(retry.statusCode).toBe(201); // the original outcome, as if the response had not been lost
    expect(retry.json()).toEqual(first.json());
    expect(await attendanceFor(sessionId)).toBe(1);
    expect(await attemptsFor(sessionId)).toHaveLength(1);
  });

  it('replays a rejection too, so a retry cannot succeed where the original did not', async () => {
    const sessionId = await newSession();
    const [s] = await nextStudents(1);
    const token = await codeFor(sessionId);
    const attemptId = randomUUID();
    const first = await scan(s!.cookie, token, { attemptId });
    const retry = await scan(s!.cookie, token, { attemptId });
    expect(first.statusCode).toBe(409);
    expect(retry.statusCode).toBe(409);
    expect(retry.json().error.code).toBe('SESSION_NOT_STARTED');
    expect(await attemptsFor(sessionId)).toHaveLength(1);
  });
});

describe('rate limiting', () => {
  it('allows about ten scans a minute per student, then asks them to wait', async () => {
    const sessionId = await openSession();
    const [s] = await nextStudents(1);
    const token = await codeFor(sessionId);
    let limited: Awaited<ReturnType<typeof scan>> | undefined;
    for (let i = 0; i < 25 && !limited; i++) {
      const res = await scan(s!.cookie, token);
      if (res.statusCode === 429) limited = res;
    }
    expect(limited?.statusCode).toBe(429);
    expect(limited?.json().error.code).toBe('RATE_LIMITED');
    expect(limited?.headers['retry-after']).toBeDefined();
    expect(await attendanceFor(sessionId)).toBe(1); // the first scan still counted, once
  });
});

describe('CONC-02 / CONC-03 concurrent scans', () => {
  it('records two students scanning the same code at the same instant', async () => {
    const sessionId = await openSession();
    const token = await codeFor(sessionId);
    const [a, b] = await nextStudents(2);
    const [ra, rb] = await Promise.all([scan(a!.cookie, token), scan(b!.cookie, token)]);
    expect([ra.statusCode, rb.statusCode]).toEqual([201, 201]);
    expect(await attendanceFor(sessionId)).toBe(2);
  });

  it('collapses 50 simultaneous scans by one student into one record', async () => {
    const sessionId = await openSession();
    const [s] = await nextStudents(1);
    const token = verifyToken(keyring, await codeFor(sessionId));
    if (!token.ok) throw new Error('bad token');

    const results = await Promise.all(
      Array.from({ length: 50 }, () =>
        checkIn(db.appPool, {
          studentId: s!.id,
          token: token.payload,
          clientAttemptId: randomUUID(),
          ipHash: null,
          userAgentFamily: null,
        }),
      ),
    );
    expect(results.filter((r) => r.kind === 'RECORDED')).toHaveLength(1);
    expect(results.filter((r) => r.kind === 'ALREADY_RECORDED')).toHaveLength(49);
    expect(await attendanceFor(sessionId)).toBe(1);
    expect(
      await count(
        'SELECT 1 FROM attendance_revisions r JOIN attendance_records a ON a.id = r.attendance_id WHERE a.session_id = $1',
        [sessionId],
      ),
    ).toBe(1);
    expect(
      await count('SELECT 1 FROM roster_links WHERE student_id = $1 AND course_id = $2', [
        s!.id,
        courseId,
      ]),
    ).toBe(1);
    const outcomes = (await attemptsFor(sessionId)).map((a) => a.outcome);
    expect(outcomes.filter((o) => o === 'ACCEPTED')).toHaveLength(1);
    expect(outcomes.filter((o) => o === 'DUPLICATE_EXISTING')).toHaveLength(49);
  });
});

describe('CONC-01 no check-in is accepted after the session ends', () => {
  it('300 students racing an End: every accepted record predates the end, none after', async () => {
    const sessionId = await openSession();
    const token = await codeFor(sessionId);
    const crowd = await nextStudents(300);

    // Scans arrive steadily over about a second.
    const scans = crowd.map(async (s, i) => {
      await new Promise((r) => setTimeout(r, i * 3));
      return scan(s.cookie, token);
    });
    // The lecturer's End gets its own connection pool; sharing the scans' pool would queue it
    // behind all 300 of them and there would be no race to test.
    const lecturerPool = new pg.Pool({
      connectionString: db.connectionString,
      options: `-c role=${db.appRole}`,
      max: 2,
    });
    const ending = (async () => {
      // End as soon as a real number of check-ins have landed, so scans are certainly still arriving.
      for (;;) {
        if ((await attendanceFor(sessionId)) >= 50) break;
        await new Promise((r) => setTimeout(r, 4));
      }
      try {
        return await endSessionService(lecturerPool, { courseId, sessionId, actorId: lecturer.id });
      } finally {
        await lecturerPool.end();
      }
    })();
    const [results, endRes] = await Promise.all([Promise.all(scans), ending]);

    expect(endRes.state).toBe('ENDED');
    const statuses = results.map((r) => r.statusCode);
    expect(statuses.every((s) => s === 201 || s === 409)).toBe(true); // never a 5xx or a lost scan
    const accepted = statuses.filter((s) => s === 201).length;
    const rejected = results.filter((r) => r.statusCode === 409);
    expect(rejected.every((r) => r.json().error.code === 'SESSION_ENDED')).toBe(true);
    expect(accepted).toBeGreaterThan(0);
    expect(rejected.length).toBeGreaterThan(0); // the race really did straddle the end

    expect(await attendanceFor(sessionId)).toBe(accepted); // every 201 is a row; no 409 left one behind
    const late = await count(
      `SELECT 1 FROM attendance_records a JOIN class_sessions s ON s.id = a.session_id WHERE a.session_id = $1 AND a.recorded_at >= s.ended_at`,
      [sessionId],
    );
    expect(late).toBe(0);

    const outcomes = (await attemptsFor(sessionId)).map((a) => a.outcome);
    expect(outcomes.filter((o) => o === 'ACCEPTED')).toHaveLength(accepted);
    expect(outcomes.filter((o) => o === 'REJECTED_SESSION_ENDED')).toHaveLength(rejected.length);

    // And once ended, a brand-new scan is refused.
    const [latecomer] = await nextStudents(1);
    expect((await scan(latecomer!.cookie, token)).statusCode).toBe(409);
  }, 60_000);
});

describe('CONC-05 failures leave no partial state and retries are safe', () => {
  async function withTrigger<T>(
    name: string,
    body: string,
    studentId: string,
    fn: () => Promise<T>,
  ): Promise<T> {
    await db.pool.query(
      `CREATE OR REPLACE FUNCTION ${name}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN ${body} RETURN NEW; END $$`,
    );
    await db.pool.query(
      `CREATE TRIGGER ${name}_trg BEFORE INSERT ON scan_attempts FOR EACH ROW WHEN (NEW.student_id = '${studentId}') EXECUTE FUNCTION ${name}()`,
    );
    try {
      return await fn();
    } finally {
      await db.pool.query(`DROP TRIGGER IF EXISTS ${name}_trg ON scan_attempts`);
    }
  }

  it('a failure at the last step rolls everything back; retrying with the same attempt id succeeds once', async () => {
    const sessionId = await openSession();
    const [s] = await nextStudents(1);
    const token = await codeFor(sessionId);
    const attemptId = randomUUID();

    const failed = await withTrigger('boom', `RAISE EXCEPTION 'forced failure';`, s!.id, () =>
      scan(s!.cookie, token, { attemptId }),
    );
    expect(failed.statusCode).toBe(500);
    expect(await attendanceFor(sessionId)).toBe(0);
    expect(
      await count(
        'SELECT 1 FROM attendance_revisions r JOIN attendance_records a ON a.id = r.attendance_id WHERE a.session_id = $1',
        [sessionId],
      ),
    ).toBe(0);
    expect(await count('SELECT 1 FROM roster_links WHERE student_id = $1', [s!.id])).toBe(0); // even the link
    expect(await attemptsFor(sessionId)).toHaveLength(0);

    const retry = await scan(s!.cookie, token, { attemptId });
    expect(retry.statusCode).toBe(201);
    expect(await attendanceFor(sessionId)).toBe(1);
    expect(await attemptsFor(sessionId)).toHaveLength(1);
  });

  it('a connection killed mid-transaction is retried transparently and records exactly one check-in', async () => {
    const sessionId = await openSession();
    const [s] = await nextStudents(1);
    const parsed = verifyToken(keyring, await codeFor(sessionId));
    if (!parsed.ok) throw new Error('bad token');

    const result = await withTrigger('slow', `PERFORM pg_sleep(1.5);`, s!.id, async () => {
      const inFlight = checkIn(db.appPool, {
        studentId: s!.id,
        token: parsed.payload,
        clientAttemptId: randomUUID(),
        ipHash: null,
        userAgentFamily: null,
      });
      await new Promise((r) => setTimeout(r, 400));
      // Kill the backend while it sleeps inside the transaction. (Dropping the trigger first
      // would block on the very transaction we want to kill.) Then let the retry run unimpeded.
      // Only backends of this test's own role, in this test's own database.
      const candidates = await db.pool.query<{ pid: number; usename: string; query: string }>(
        `SELECT pid, usename::text AS usename, left(query, 80) AS query FROM pg_stat_activity
          WHERE datname = current_database() AND pid <> pg_backend_pid() AND state = 'active'
            AND query ILIKE '%INSERT INTO scan_attempts%'`,
      );
      const mine = candidates.rows.filter(
        (r) => r.usename === 'scanin_test' || r.usename === process.env.PGUSER,
      );
      const killed = { rowCount: 0 };
      for (const row of candidates.rows) {
        try {
          await db.pool.query('SELECT pg_terminate_backend($1)', [row.pid]);
          killed.rowCount += 1;
        } catch (err) {
          throw new Error(
            `cannot terminate ${JSON.stringify(row)}: ${(err as Error).message}; candidates=${JSON.stringify(candidates.rows)} mine=${mine.length}`,
            { cause: err },
          );
        }
      }
      expect(killed.rowCount).toBeGreaterThan(0);
      await db.pool.query(`DROP TRIGGER IF EXISTS slow_trg ON scan_attempts`);
      return inFlight;
    });

    expect(result.kind).toBe('RECORDED');
    expect(await attendanceFor(sessionId)).toBe(1);
    expect(await attemptsFor(sessionId)).toHaveLength(1);
    expect(
      await count(
        'SELECT 1 FROM attendance_revisions r JOIN attendance_records a ON a.id = r.attendance_id WHERE a.session_id = $1',
        [sessionId],
      ),
    ).toBe(1);
  }, 30_000);

  it('a lost response is harmless: asking again returns the recorded result', async () => {
    const sessionId = await openSession();
    const [s] = await nextStudents(1);
    const parsed = verifyToken(keyring, await codeFor(sessionId));
    if (!parsed.ok) throw new Error('bad token');
    const input = {
      studentId: s!.id,
      token: parsed.payload,
      clientAttemptId: randomUUID(),
      ipHash: null,
      userAgentFamily: null,
    };
    const first = await checkIn(db.appPool, input); // the client never hears about this
    const again = await checkIn(db.appPool, input);
    expect(first.kind).toBe('RECORDED');
    expect(again.kind).toBe('RECORDED');
    expect(await attendanceFor(sessionId)).toBe(1);
  });
});

describe('CONC-06 two accounts claiming one roster entry while checking in', () => {
  it('records both check-ins, gives the entry to only one account, and sends both to review', async () => {
    const course = await newCourse();
    const sessionId = await openSession(course);
    const [byEmail, byId] = await nextStudents(2);
    await db.pool.query(
      `UPDATE users SET email = 'claim@school.test', email_verified_at = now() WHERE id = $1`,
      [byEmail!.id],
    );
    const csvText = `student_id,full_name,email\n${byId!.studentId},Contested Student,claim@school.test\n`;
    const preview = await post(
      t.app,
      `/courses/${course}/roster/preview`,
      { csv: csvText },
      { cookie: lecturer.cookie },
    );
    await post(
      t.app,
      `/courses/${course}/roster/apply`,
      { csv: csvText, previewToken: preview.json().previewToken, retireEntryIds: [] },
      { cookie: lecturer.cookie },
    );

    const token = await codeFor(sessionId);
    const [r1, r2] = await Promise.all([scan(byEmail!.cookie, token), scan(byId!.cookie, token)]);
    expect([r1.statusCode, r2.statusCode]).toEqual([201, 201]);
    expect(await attendanceFor(sessionId)).toBe(2);

    const holders = await count(
      `SELECT 1 FROM roster_links WHERE course_id = $1 AND roster_entry_id IS NOT NULL AND state <> 'REJECTED'`,
      [course],
    );
    expect(holders).toBe(1);
    expect(
      await count(
        `SELECT 1 FROM investigation_flags WHERE course_id = $1 AND kind = 'CONFLICTING_STUDENT_ID'`,
        [course],
      ),
    ).toBe(1);
    const states = (
      await db.pool.query(`SELECT state::text FROM roster_links WHERE course_id = $1`, [course])
    ).rows.map((r) => r.state);
    expect(states).toEqual(['REVIEW_REQUIRED', 'REVIEW_REQUIRED']);
  });
});

describe('QR-08 check-in never writes codes or credentials to logs', () => {
  it('keeps codes, code fragments and session cookies out of the log output', async () => {
    const sessionId = await openSession();
    const good = await codeFor(sessionId);
    const [s] = await nextStudents(1);
    await scan(s!.cookie, good);
    await scan(s!.cookie, good); // duplicate
    await scan(s!.cookie, 'ST1.k1.forged.value'); // forged
    const logs = t.logs();
    expect(logs).not.toContain(good);
    expect(logs).not.toContain(good.split('.')[2]);
    expect(logs).not.toContain('forged.value');
    expect(logs).not.toContain('ST1.');
    expect(logs).not.toContain(s!.cookie.split('=')[1]);
  });
});

describe('device binding: one phone, one student per class', () => {
  it('blocks a second student on the same device and records only a rejection', async () => {
    const sessionId = await openSession();
    const token = await codeFor(sessionId);
    const [a, b] = await nextStudents(2);
    const device = randomUUID();
    expect((await scan(a!.cookie, token, { deviceId: device })).statusCode).toBe(201);

    const blocked = await scan(b!.cookie, token, { deviceId: device });
    expect(blocked.statusCode).toBe(403);
    expect(blocked.json().error.code).toBe('DEVICE_ALREADY_USED');
    expect(await attendanceFor(sessionId)).toBe(1);
    const outcomes = (await attemptsFor(sessionId)).map((x) => x.outcome);
    expect(outcomes).toEqual(['ACCEPTED', 'REJECTED_DEVICE_REUSED']);
    expect(
      await count(
        `SELECT 1 FROM audit_events WHERE session_id = $1 AND action = 'CHECKIN_DEVICE_REUSED'`,
        [sessionId],
      ),
    ).toBe(1);
    // The raw device id is never stored.
    const stored = await db.pool.query<{ device_hash: Buffer }>(
      'SELECT device_hash FROM attendance_records WHERE session_id = $1',
      [sessionId],
    );
    expect(stored.rows[0]!.device_hash.toString('hex')).not.toContain(device.replaceAll('-', ''));
  });

  it('lets the same student repeat on their own device, and other devices check in freely', async () => {
    const sessionId = await openSession();
    const token = await codeFor(sessionId);
    const [a, b] = await nextStudents(2);
    const device = randomUUID();
    expect((await scan(a!.cookie, token, { deviceId: device })).statusCode).toBe(201);
    expect((await scan(a!.cookie, token, { deviceId: device })).statusCode).toBe(200);
    expect((await scan(b!.cookie, token, { deviceId: randomUUID() })).statusCode).toBe(201);
    expect(await attendanceFor(sessionId)).toBe(2);
  });

  it('allows the same device in a different class session', async () => {
    const device = randomUUID();
    const [a, b] = await nextStudents(2);
    for (const s of [a!, b!]) {
      const sessionId = await openSession();
      expect(
        (await scan(s.cookie, await codeFor(sessionId), { deviceId: device })).statusCode,
      ).toBe(201);
    }
  });

  it('only one of two simultaneous students on a device gets in', async () => {
    const sessionId = await openSession();
    const token = await codeFor(sessionId);
    const [a, b] = await nextStudents(2);
    const device = randomUUID();
    const codes = (
      await Promise.all([
        scan(a!.cookie, token, { deviceId: device }),
        scan(b!.cookie, token, { deviceId: device }),
      ])
    )
      .map((r) => r.statusCode)
      .sort();
    expect(codes).toEqual([201, 403]);
    expect(await attendanceFor(sessionId)).toBe(1);
  });

  it('FLAG policy records both and raises a system flag on each record, changing nothing else', async () => {
    const sessionId = await openSession();
    const token = verifyToken(keyring, await codeFor(sessionId));
    if (!token.ok) throw new Error('bad token');
    const [a, b] = await nextStudents(2);
    const deviceHash = Buffer.alloc(32, 7);
    for (const s of [a!, b!]) {
      const r = await checkIn(db.appPool, {
        studentId: s.id,
        token: token.payload,
        clientAttemptId: randomUUID(),
        ipHash: null,
        userAgentFamily: null,
        deviceHash,
        devicePolicy: 'FLAG',
      });
      expect(r.kind).toBe('RECORDED');
    }
    expect(await attendanceFor(sessionId)).toBe(2);
    const flags = await db.pool.query(
      `SELECT f.kind::text AS kind, f.origin::text AS origin, f.state::text AS state
         FROM investigation_flags f WHERE f.session_id = $1`,
      [sessionId],
    );
    expect(flags.rows).toHaveLength(2);
    expect(flags.rows.every((f) => f.kind === 'PROXY_SUSPECTED' && f.origin === 'SYSTEM')).toBe(
      true,
    );
    expect(
      await count(`SELECT 1 FROM attendance_records WHERE session_id = $1 AND status = 'PRESENT'`, [
        sessionId,
      ]),
    ).toBe(2);
  });

  it('rejects a malformed device id', async () => {
    const sessionId = await openSession();
    const token = await codeFor(sessionId);
    const [a] = await nextStudents(1);
    const bad = await post(
      t.app,
      '/checkins',
      { token, clientAttemptId: randomUUID(), deviceId: 'not-a-uuid' },
      { cookie: a!.cookie, ip: freshIp(), headers: {} },
    );
    expect(bad.statusCode).toBe(400);
    expect(await attendanceFor(sessionId)).toBe(0);
  });

  it('records nothing when a check-in leaves the device id out, so omitting it cannot skip the rule', async () => {
    const sessionId = await openSession();
    const token = await codeFor(sessionId);
    const [a, b] = await nextStudents(2);
    for (const s of [a!, b!]) {
      const res = await scan(s.cookie, token, { deviceId: null });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe('DEVICE_ID_REQUIRED');
    }
    expect(await attendanceFor(sessionId)).toBe(0);
    expect(await attemptsFor(sessionId)).toEqual([]);
    expect(
      await count(
        `SELECT 1 FROM audit_events WHERE action = 'CHECKIN_DEVICE_ID_MISSING' AND actor_user_id = $1`,
        [a!.id],
      ),
    ).toBe(1);
    // Once the app sends its id, the same student checks in normally.
    expect((await scan(a!.cookie, token, { deviceId: randomUUID() })).statusCode).toBe(201);
  });

  it('does not let a rejected attempt use up a device', async () => {
    const sessionId = await openSession();
    const stale = await codeFor(sessionId, 4 * 60_000); // older than the three-minute lifetime
    const fresh = await codeFor(sessionId);
    const [a, b] = await nextStudents(2);
    const device = randomUUID();
    expect((await scan(a!.cookie, stale, { deviceId: device })).statusCode).toBe(410);
    expect(await count('SELECT 1 FROM device_sessions WHERE session_id = $1', [sessionId])).toBe(0);
    expect((await scan(b!.cookie, fresh, { deviceId: device })).statusCode).toBe(201);
  });

  it('REPORTED CASE: two student accounts signing in one after the other on the same browser', async () => {
    const sessionId = await openSession();
    const token = await codeFor(sessionId);
    const device = randomUUID(); // what the one browser keeps in its storage across both logins
    const first = await registerAndLogin(t.app);
    const second = await registerAndLogin(t.app);

    // Account A signs in and checks in. Repeating it is not a duplicate. Then A signs out.
    expect((await scan(first.cookie, token, { deviceId: device })).statusCode).toBe(201);
    const repeat = await scan(first.cookie, token, { deviceId: device });
    expect(repeat.statusCode).toBe(200);
    expect(repeat.json().result).toBe('ALREADY_RECORDED');
    await post(t.app, '/auth/logout', {}, { cookie: first.cookie });

    // Account B signs in on the same browser and scans the same code.
    const blocked = await scan(second.cookie, token, { deviceId: device });
    expect(blocked.statusCode).toBe(403);
    expect(blocked.json().error.code).toBe('DEVICE_ALREADY_USED');

    // Nothing about account A leaks to account B.
    const body = blocked.body;
    for (const secret of [first.reg.email, first.reg.fullName, first.reg.studentId, device]) {
      expect(body).not.toContain(secret);
    }

    // Persisted state: one attendance record (A's), one device claim (A's), B only a rejection.
    const records = await db.pool.query<{ email: string }>(
      `SELECT u.email FROM attendance_records a JOIN users u ON u.id = a.student_id WHERE a.session_id = $1`,
      [sessionId],
    );
    expect(records.rows).toEqual([{ email: first.reg.email.toLowerCase() }]);
    expect(await count('SELECT 1 FROM device_sessions WHERE session_id = $1', [sessionId])).toBe(1);
    expect((await attemptsFor(sessionId)).map((x) => x.outcome)).toEqual([
      'ACCEPTED',
      'DUPLICATE_EXISTING', // A's own repeat
      'REJECTED_DEVICE_REUSED', // B on the same browser
    ]);

    // The audit event names no one else's identity and holds no device id, token or cookie.
    const audit = await db.pool.query<{ summary: unknown }>(
      `SELECT summary FROM audit_events WHERE session_id = $1 AND action = 'CHECKIN_DEVICE_REUSED'`,
      [sessionId],
    );
    expect(audit.rows).toHaveLength(1);
    const logged = JSON.stringify(audit.rows[0]);
    for (const secret of [first.reg.email, first.reg.studentId, device, token]) {
      expect(logged).not.toContain(secret);
    }
  });
});

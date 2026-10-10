import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { assignLecturer, createCourse, createTerm } from '../../src/operator/commands.js';
import { mintToken, parseKeyring } from '../../src/qr/token.js';
import {
  TEST_CONFIG,
  createLecturerSession,
  createTestApp,
  freshIp,
  get,
  post,
  type TestApp,
} from '../helpers/app.js';
import { createLink, createSession } from '../helpers/seed.js';
import { createBulkStudents, type BulkStudent } from '../helpers/students.js';
import { createMigratedTestDatabase, type MigratedTestDatabase } from '../helpers/testDb.js';

let db: MigratedTestDatabase;
let t: TestApp;
let lecturer1: { id: string; cookie: string };
let lecturer2: { id: string; cookie: string };
const operator = 'attendance-test';
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
  lecturer1 = await createLecturerSession(db, t.app, 'lec1@school.test');
  lecturer2 = await createLecturerSession(db, t.app, 'lec2@school.test');
});

afterAll(async () => {
  await t?.close();
  await db?.drop();
});

async function newCourse(owner = 'lec1@school.test'): Promise<string> {
  courseSeq += 1;
  const code = `A${courseSeq}`;
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
    lecturerEmail: owner,
  });
  return id;
}

const sessionUrl = (course: string, session: string, tail = '') =>
  `/courses/${course}/sessions/${session}${tail}`;

async function openSession(course: string): Promise<string> {
  const id = (
    await post(
      t.app,
      `/courses/${course}/sessions`,
      { title: 'Lecture' },
      { cookie: lecturer1.cookie },
    )
  ).json().session.id as string;
  await post(t.app, sessionUrl(course, id, '/start'), {}, { cookie: lecturer1.cookie });
  return id;
}

async function scan(
  student: BulkStudent,
  sessionId: string,
  opts: { ip?: string; ua?: string } = {},
) {
  const now = Number(
    (
      await db.pool.query<{ ms: string }>(
        `SELECT floor(extract(epoch FROM clock_timestamp())*1000)::bigint AS ms`,
      )
    ).rows[0]!.ms,
  );
  return post(
    t.app,
    '/checkins',
    { token: mintToken(keyring, sessionId, now).token, clientAttemptId: randomUUID() },
    {
      cookie: student.cookie,
      ip: opts.ip ?? freshIp(),
      headers: opts.ua ? { 'user-agent': opts.ua } : {},
    },
  );
}

async function students(n: number) {
  return createBulkStudents(db, n);
}

const roster = async (course: string, session: string, cookie = lecturer1.cookie) =>
  (await get(t.app, sessionUrl(course, session, '/attendance'), { cookie })).json();

/** Records an attendance row directly (owner connection), optionally invalidated or manual. */
async function seedAttendance(
  course: string,
  sessionId: string,
  studentId: string,
  linkId: string,
  opts: { invalidated?: boolean; manual?: boolean } = {},
): Promise<string> {
  const c = await db.pool.connect();
  try {
    await c.query('BEGIN');
    const { rows } = await c.query<{ id: string }>(
      `INSERT INTO attendance_records (session_id, course_id, student_id, link_id, source, manual_marked_by)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [
        sessionId,
        course,
        studentId,
        linkId,
        opts.manual ? 'MANUAL' : 'QR_SCAN',
        opts.manual ? lecturer1.id : null,
      ],
    );
    const id = rows[0]!.id;
    await c.query(
      `INSERT INTO attendance_revisions (attendance_id, rev_no, change_kind, from_status, to_status, actor_user_id, explanation)
       VALUES ($1, 1, $2, NULL, 'PRESENT', $3, $4)`,
      [
        id,
        opts.manual ? 'CREATED_MANUAL' : 'CREATED_QR',
        opts.manual ? lecturer1.id : studentId,
        opts.manual ? 'Marked present by lecturer in test' : null,
      ],
    );
    if (opts.invalidated) {
      await c.query(
        `INSERT INTO attendance_revisions (attendance_id, rev_no, change_kind, from_status, to_status, actor_user_id, reason_category, explanation)
         VALUES ($1, 2, 'INVALIDATED', 'PRESENT', 'INVALIDATED', $2, 'CONFIRMED_PROXY', 'Secret investigation note')`,
        [id, lecturer1.id],
      );
      await c.query(
        `UPDATE attendance_records SET status = 'INVALIDATED', current_rev_no = 2 WHERE id = $1`,
        [id],
      );
    }
    await c.query('COMMIT');
    return id;
  } catch (err) {
    await c.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    c.release();
  }
}

async function addFlag(
  course: string,
  target: { attendanceId?: string; linkId?: string },
  state: 'OPEN' | 'UNDER_REVIEW' | 'DISMISSED' | 'SUBSTANTIATED' = 'OPEN',
) {
  const kind = target.attendanceId ? 'PROXY_SUSPECTED' : 'AMBIGUOUS_ROSTER_MATCH';
  const c = await db.pool.connect();
  try {
    await c.query('BEGIN');
    const { rows } = await c.query<{ id: string }>(
      `INSERT INTO investigation_flags (course_id, attendance_id, roster_link_id, kind, origin, raised_by, state, current_event_no)
       VALUES ($1, $2, $3, $4, 'LECTURER', $5, $6, $7) RETURNING id`,
      [
        course,
        target.attendanceId ?? null,
        target.linkId ?? null,
        kind,
        lecturer1.id,
        state,
        state === 'OPEN' ? 1 : 2,
      ],
    );
    const id = rows[0]!.id;
    await c.query(
      `INSERT INTO investigation_flag_events (flag_id, event_no, from_state, to_state, actor_user_id) VALUES ($1, 1, NULL, 'OPEN', $2)`,
      [id, lecturer1.id],
    );
    if (state !== 'OPEN') {
      await c.query(
        `INSERT INTO investigation_flag_events (flag_id, event_no, from_state, to_state, actor_user_id, note) VALUES ($1, 2, 'OPEN', $2, $3, $4)`,
        [id, state, lecturer1.id, 'Reviewed carefully in test'],
      );
    }
    await c.query('COMMIT');
  } finally {
    c.release();
  }
}

describe('ATT-01 provisional attendance counts as provisional, not confirmed', () => {
  it('a course without a roster: three check-ins give provisional=3, confirmed=0, present total 3', async () => {
    const course = await newCourse();
    const session = await openSession(course);
    for (const s of await students(3)) expect((await scan(s, session)).statusCode).toBe(201);

    const { counts, records } = await roster(course, session);
    expect(counts).toEqual({
      presentTotal: 3,
      confirmed: 0,
      provisional: 3,
      reviewRequired: 0,
      invalidated: 0,
      flaggedPresent: 0,
    });
    expect(records).toHaveLength(3);
    expect(
      records.every(
        (r: { associationState: string; status: string }) =>
          r.associationState === 'PROVISIONAL' && r.status === 'PRESENT',
      ),
    ).toBe(true);
  });

  it('roster-matched students are confirmed; a student not on the roster needs review; both are present', async () => {
    const course = await newCourse();
    const [onRoster, offRoster] = await students(2);
    const csvText = `student_id,full_name\n${onRoster!.studentId},On Roster\nOTHER001,Someone Else\n`;
    const preview = await post(
      t.app,
      `/courses/${course}/roster/preview`,
      { csv: csvText },
      { cookie: lecturer1.cookie },
    );
    await post(
      t.app,
      `/courses/${course}/roster/apply`,
      { csv: csvText, previewToken: preview.json().previewToken, retireEntryIds: [] },
      { cookie: lecturer1.cookie },
    );
    const session = await openSession(course);
    await scan(onRoster!, session);
    await scan(offRoster!, session);

    const body = await roster(course, session);
    expect(body.counts).toMatchObject({
      presentTotal: 2,
      confirmed: 1,
      reviewRequired: 1,
      provisional: 0,
    });
    expect(body.noRecord).toEqual([
      {
        entryId: expect.any(String),
        studentId: 'OTHER001',
        fullName: 'Someone Else',
        registered: false,
      },
    ]);
  });
});

describe('ATT-03 the buckets partition the records without double counting', () => {
  it('matches an independent model across many random datasets', async () => {
    const course = await newCourse();
    const pool = await students(40);
    const linkStates = ['PROVISIONAL', 'REVIEW_REQUIRED', 'CONFIRMED', 'REJECTED'] as const;
    // Deterministic pseudo-random generator so a failure is reproducible.
    let seed = 20261010;
    const rnd = () => (seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296;
    const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)]!;

    const links = new Map<string, { id: string; state: (typeof linkStates)[number] }>();
    for (const s of pool) {
      const state = pick(linkStates);
      links.set(s.id, { id: await createLink(db.pool, course, s.id, { state }), state });
    }

    // Association-level flags stay active across sessions (one active flag of a kind per link).
    const activeLinkFlag = new Set<string>();

    for (let round = 0; round < 25; round++) {
      const sessionId = await createSession(db.pool, course, lecturer1.id, 'CHECK_IN_OPEN');
      const expected = {
        confirmed: 0,
        provisional: 0,
        reviewRequired: 0,
        invalidated: 0,
        flaggedPresent: 0,
      };
      let records = 0;
      for (const s of pool.filter(() => rnd() < 0.5)) {
        const link = links.get(s.id)!;
        const invalidated = rnd() < 0.25;
        const attendanceId = await seedAttendance(course, sessionId, s.id, link.id, {
          invalidated,
        });
        records += 1;

        // Random flags, on the record or on the student's association. Only OPEN / UNDER_REVIEW count.
        let recordFlagActive = false;
        const flagState = pick([
          'OPEN',
          'UNDER_REVIEW',
          'DISMISSED',
          'SUBSTANTIATED',
          null,
          null,
        ] as const);
        if (flagState) {
          const active = flagState === 'OPEN' || flagState === 'UNDER_REVIEW';
          if (rnd() < 0.5) {
            await addFlag(course, { attendanceId }, flagState);
            recordFlagActive = active;
          } else if (!(active && activeLinkFlag.has(link.id))) {
            await addFlag(course, { linkId: link.id }, flagState);
            if (active) activeLinkFlag.add(link.id);
          }
        }
        const flagged = recordFlagActive || activeLinkFlag.has(link.id);

        if (invalidated) expected.invalidated += 1;
        else {
          if (link.state === 'CONFIRMED') expected.confirmed += 1;
          else if (link.state === 'PROVISIONAL') expected.provisional += 1;
          else expected.reviewRequired += 1; // REVIEW_REQUIRED and REJECTED both await a decision
          if (flagged) expected.flaggedPresent += 1;
        }
      }

      const { counts } = await roster(course, sessionId);
      expect(counts, `round ${round}`).toEqual({
        ...expected,
        presentTotal: expected.confirmed + expected.provisional + expected.reviewRequired,
      });
      // The four exclusive buckets account for every record exactly once.
      expect(
        counts.confirmed + counts.provisional + counts.reviewRequired + counts.invalidated,
        `round ${round}`,
      ).toBe(records);
      expect(counts.flaggedPresent).toBeLessThanOrEqual(counts.presentTotal);
    }
  }, 120_000);

  it('flags overlay without moving a record between buckets, and dismissal removes them', async () => {
    const course = await newCourse();
    const [s] = await students(1);
    const link = await createLink(db.pool, course, s!.id, { state: 'CONFIRMED' });
    const sessionId = await createSession(db.pool, course, lecturer1.id, 'CHECK_IN_OPEN');
    const attendanceId = await seedAttendance(course, sessionId, s!.id, link);

    const before = (await roster(course, sessionId)).counts;
    expect(before).toMatchObject({ presentTotal: 1, confirmed: 1, flaggedPresent: 0 });

    await addFlag(course, { attendanceId }, 'UNDER_REVIEW');
    const flagged = await roster(course, sessionId);
    expect(flagged.counts).toMatchObject({ presentTotal: 1, confirmed: 1, flaggedPresent: 1 }); // same bucket, now flagged
    expect(flagged.records[0]).toMatchObject({
      status: 'PRESENT',
      flagged: true,
      flagKinds: ['PROXY_SUSPECTED'],
    });

    await addFlag(course, { linkId: link }, 'SUBSTANTIATED');
    expect((await roster(course, sessionId)).counts).toMatchObject({
      confirmed: 1,
      flaggedPresent: 1,
    }); // a substantiated flag is not active; attendance untouched
  });

  it('keeps invalidated records out of every present total', async () => {
    const course = await newCourse();
    const [a, b] = await students(2);
    const sessionId = await createSession(db.pool, course, lecturer1.id, 'CHECK_IN_OPEN');
    await seedAttendance(
      course,
      sessionId,
      a!.id,
      await createLink(db.pool, course, a!.id, { state: 'CONFIRMED' }),
    );
    await seedAttendance(
      course,
      sessionId,
      b!.id,
      await createLink(db.pool, course, b!.id, { state: 'CONFIRMED' }),
      { invalidated: true },
    );
    expect((await roster(course, sessionId)).counts).toEqual({
      presentTotal: 1,
      confirmed: 1,
      provisional: 0,
      reviewRequired: 0,
      invalidated: 1,
      flaggedPresent: 0,
    });
  });
});

describe('UX-04 the session roster carries no scan times', () => {
  it('shows who attended and in what state, with source, association and flags, but no timestamps', async () => {
    const course = await newCourse();
    const [qr, manual] = await students(2);
    const session = await openSession(course);
    await scan(qr!, session);
    const link = await createLink(db.pool, course, manual!.id, { state: 'PROVISIONAL' });
    await seedAttendance(course, session, manual!.id, link, { manual: true });

    const res = await get(t.app, sessionUrl(course, session, '/attendance'), {
      cookie: lecturer1.cookie,
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/); // no ISO timestamps anywhere
    const keys = JSON.stringify(
      Object.keys(JSON.parse(res.body)).concat(
        ...res.json().records.map((r: object) => Object.keys(r)),
      ),
    );
    expect(keys).not.toMatch(/at"|time|received|recorded|created/i);

    const sources = Object.fromEntries(
      res.json().records.map((r: { studentId: string; source: string }) => [r.studentId, r.source]),
    );
    expect(sources[qr!.studentId]).toBe('QR_SCAN');
    expect(sources[manual!.studentId]).toBe('MANUAL'); // manual attendance is distinguishable
  });

  it("is limited to the course's assigned lecturers", async () => {
    const course = await newCourse();
    const session = await openSession(course);
    expect(
      (await get(t.app, sessionUrl(course, session, '/attendance'), { cookie: lecturer2.cookie }))
        .statusCode,
    ).toBe(404);
    expect(
      (
        await get(t.app, sessionUrl(course, 'not-a-uuid', '/attendance'), {
          cookie: lecturer1.cookie,
        })
      ).statusCode,
    ).toBe(404);
    const otherCourse = await newCourse();
    expect(
      (
        await get(t.app, sessionUrl(otherCourse, session, '/attendance'), {
          cookie: lecturer1.cookie,
        })
      ).statusCode,
    ).toBe(404);
  });
});

describe('the scan-history view', () => {
  let course: string;
  let session: string;
  let people: BulkStudent[];

  beforeAll(async () => {
    course = await newCourse();
    session = await openSession(course);
    people = await students(7);
    const sharedIp = '10.99.0.1';
    for (const [i, s] of people.entries()) {
      await scan(s, session, {
        ip: i < 3 ? sharedIp : freshIp(),
        ua:
          i % 2
            ? 'Mozilla/5.0 (Android) Chrome/120.0 Mobile Safari/537.36'
            : 'Mozilla/5.0 (iPhone) AppleWebKit Version/17.0 Mobile Safari/604.1',
      });
    }
    await scan(people[0]!, session); // a duplicate
    await post(t.app, sessionUrl(course, session, '/end'), {}, { cookie: lecturer1.cookie });
    await scan((await students(1))[0]!, session); // rejected: ended
  });

  const history = (query = '', cookie = lecturer1.cookie) =>
    get(t.app, sessionUrl(course, session, `/scans${query}`), { cookie });

  it('lists every attempt, newest first, with times, outcomes, browser family and a network label', async () => {
    const body = (await history()).json();
    expect(body.scans).toHaveLength(9);
    const outcomes = body.scans.map((s: { outcome: string }) => s.outcome);
    expect(outcomes[0]).toBe('REJECTED_SESSION_ENDED');
    expect(outcomes.filter((o: string) => o === 'ACCEPTED')).toHaveLength(7);
    expect(outcomes.filter((o: string) => o === 'DUPLICATE_EXISTING')).toHaveLength(1);
    const times = body.scans.map((s: { receivedAt: string }) => s.receivedAt);
    expect(times).toEqual([...times].sort().reverse());
    expect(times.every((x: string) => /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(x))).toBe(true);
    const browsers = new Set(body.scans.map((s: { browser: string }) => s.browser));
    expect(browsers).toContain('Safari');
    expect(browsers).toContain('Chrome');
    expect(browsers).not.toContain(undefined); // only a coarse family is stored, never the full user-agent

    // The first three students scanned from one address: their network labels are equal.
    const byStudent = Object.fromEntries(
      body.scans
        .filter((s: { outcome: string }) => s.outcome === 'ACCEPTED')
        .map((s: { studentId: string; network: string }) => [s.studentId, s.network]),
    );
    const labels = people.slice(0, 3).map((p) => byStudent[p.studentId]);
    expect(new Set(labels).size).toBe(1);
    expect(byStudent[people[3]!.studentId]).not.toBe(labels[0]);
    expect(JSON.stringify(body)).not.toContain('10.99.0.1'); // never the address itself
  });

  it('filters by outcome and searches by student ID or name', async () => {
    expect((await history('?outcome=DUPLICATE_EXISTING')).json().scans).toHaveLength(1);
    expect((await history('?outcome=REJECTED_SESSION_ENDED')).json().scans).toHaveLength(1);
    const target = people[2]!;
    const found = (
      await history(`?student=${encodeURIComponent(target.studentId.slice(2, 12).toLowerCase())}`)
    ).json().scans;
    expect(found.length).toBeGreaterThan(0);
    expect(
      found.every((s: { studentId: string }) =>
        s.studentId.toLowerCase().includes(target.studentId.slice(2, 12).toLowerCase()),
      ),
    ).toBe(true);
    expect((await history('?student=zzzz-no-such-student')).json().scans).toEqual([]);
    // LIKE wildcards in the search text are literal.
    expect((await history('?student=%25')).json().scans).toEqual([]);
  });

  it('pages through all results without gaps or repeats', async () => {
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 10; page++) {
      const body: { scans: Array<{ id: string }>; nextCursor: string | null } = (
        await history(`?limit=4${cursor ? `&before=${cursor}` : ''}`)
      ).json();
      seen.push(...body.scans.map((s: { id: string }) => s.id));
      cursor = body.nextCursor;
      if (!cursor) break;
    }
    expect(seen).toHaveLength(9);
    expect(new Set(seen).size).toBe(9);
  });

  it('rejects bad filters and cursors, and keeps students and other lecturers out', async () => {
    expect((await history('?outcome=NOPE')).statusCode).toBe(400);
    expect((await history('?limit=0')).statusCode).toBe(400);
    expect((await history('?limit=1000')).statusCode).toBe(400);
    expect((await history('?before=garbage')).statusCode).toBe(400);
    expect((await history('', lecturer2.cookie)).statusCode).toBe(404);
    expect((await history('', people[0]!.cookie)).statusCode).toBe(403);
  });
});

describe('AUTHZ-01 students see only their own attendance', () => {
  it('returns each student their own sessions and nothing of anyone else', async () => {
    const course = await newCourse();
    const [alice, bob, carol] = await students(3);
    const s1 = await openSession(course);
    const s2 = await openSession(course);
    await post(t.app, sessionUrl(course, s2, '/end'), {}, { cookie: lecturer1.cookie });
    await scan(alice!, s1);
    await scan(bob!, s1);
    // Alice also attended s2? Not possible (ended): she has a record for s1 only; Bob likewise.
    await db.pool.query(`UPDATE users SET full_name = 'Alice Wonderland' WHERE id = $1`, [
      alice!.id,
    ]);
    await db.pool.query(`UPDATE users SET full_name = 'Bob Builder' WHERE id = $1`, [bob!.id]);

    const mine = await get(t.app, '/me/attendance', { cookie: alice!.cookie });
    expect(mine.statusCode).toBe(200);
    const body = mine.json();
    expect(body.courses).toHaveLength(1);
    expect(body.courses[0]).toMatchObject({
      code: expect.stringMatching(/^A\d+$/),
      associationState: 'PROVISIONAL',
      presentCount: 1,
      sessionCount: 2,
    });
    const statuses = body.courses[0].sessions.map((s: { id: string; status: string }) => [
      s.id,
      s.status,
    ]);
    expect(statuses).toContainEqual([s1, 'PRESENT']);
    expect(statuses).toContainEqual([s2, 'NO_RECORD']); // a started session with no record: stated plainly, not as "absent"
    expect(mine.body).not.toContain('Bob');
    expect(mine.body).not.toContain(bob!.id);
    expect(mine.body).not.toContain(bob!.studentId);

    const theirs = (await get(t.app, '/me/attendance', { cookie: bob!.cookie })).json();
    expect(theirs.courses[0].presentCount).toBe(1);
    expect((await get(t.app, '/me/attendance', { cookie: carol!.cookie })).json()).toEqual({
      courses: [],
    }); // never linked to the course
  });

  it('cannot be pointed at another student by any parameter', async () => {
    const course = await newCourse();
    const [alice, bob] = await students(2);
    const s = await openSession(course);
    await scan(bob!, s);
    for (const q of [`?studentId=${bob!.id}`, `?userId=${bob!.id}`, `?student=${bob!.studentId}`]) {
      const res = await get(t.app, `/me/attendance${q}`, { cookie: alice!.cookie });
      expect(res.json()).toEqual({ courses: [] });
    }
    expect((await get(t.app, `/me/attendance`, { cookie: lecturer1.cookie })).statusCode).toBe(403);
    expect((await get(t.app, `/me/attendance`)).statusCode).toBe(401);
  });

  it("shows the invalidation category but never the lecturer's explanation or any flags", async () => {
    const course = await newCourse();
    const [s] = await students(1);
    const link = await createLink(db.pool, course, s!.id, { state: 'CONFIRMED' });
    const session = await createSession(db.pool, course, lecturer1.id, 'CHECK_IN_OPEN');
    const attendanceId = await seedAttendance(course, session, s!.id, link, { invalidated: true });
    await addFlag(course, { attendanceId }, 'OPEN');

    const res = await get(t.app, '/me/attendance', { cookie: s!.cookie });
    const entry = res.json().courses[0].sessions[0];
    expect(entry).toMatchObject({ status: 'INVALIDATED', invalidationCategory: 'CONFIRMED_PROXY' });
    expect(res.body).not.toContain('Secret investigation note');
    expect(res.body.toLowerCase()).not.toContain('flag');
    expect(res.body).not.toContain('PROXY_SUSPECTED');
  });

  it('hides sessions that have not started', async () => {
    const course = await newCourse();
    const [s] = await students(1);
    await createLink(db.pool, course, s!.id);
    await createSession(db.pool, course, lecturer1.id, 'NOT_STARTED');
    const open = await createSession(db.pool, course, lecturer1.id, 'CHECK_IN_OPEN');
    const sessions = (await get(t.app, '/me/attendance', { cookie: s!.cookie })).json().courses[0]
      .sessions;
    expect(sessions.map((x: { id: string }) => x.id)).toEqual([open]);
  });
});

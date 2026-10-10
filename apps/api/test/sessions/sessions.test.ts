import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { assignLecturer, createCourse, createTerm } from '../../src/operator/commands.js';
import {
  closeExpiredSessions,
  endSession,
  extendSession,
  type SessionError,
} from '../../src/sessions/service.js';
import {
  createLecturerSession,
  createTestApp,
  get,
  post,
  registerAndLogin,
  type TestApp,
} from '../helpers/app.js';
import { createMigratedTestDatabase, type MigratedTestDatabase } from '../helpers/testDb.js';

let db: MigratedTestDatabase;
let t: TestApp;
let lecturer1: { id: string; cookie: string };
let lecturer2: { id: string; cookie: string };
let studentCookie: string;
let courseId: string;
let otherCourseId: string;
const operator = 'session-test';

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
  studentCookie = (await registerAndLogin(t.app)).cookie;
  courseId = (
    await createCourse(db.operatorPool, { operator, term: 'T1', code: 'S1', title: 'S1' })
  ).id;
  otherCourseId = (
    await createCourse(db.operatorPool, { operator, term: 'T1', code: 'S2', title: 'S2' })
  ).id;
  await assignLecturer(db.operatorPool, {
    operator,
    term: 'T1',
    courseCode: 'S1',
    lecturerEmail: 'lec1@school.test',
  });
  await assignLecturer(db.operatorPool, {
    operator,
    term: 'T1',
    courseCode: 'S2',
    lecturerEmail: 'lec2@school.test',
  });
});

afterAll(async () => {
  await t?.close();
  await db?.drop();
});

type Stored = 'NOT_STARTED' | 'CHECK_IN_OPEN' | 'CHECK_IN_CLOSED' | 'ENDED';

/** Inserts a session straight into a lifecycle state (bypasses the API on purpose). */
async function seed(
  state: Stored | 'OPEN_EXPIRED',
  opts: { course?: string; deadlineInMs?: number } = {},
): Promise<string> {
  const course = opts.course ?? courseId;
  const by = lecturer1.id;
  const q = (sql: string) => db.pool.query<{ id: string }>(sql, [course, by]);
  switch (state) {
    case 'NOT_STARTED':
      return (
        await q(
          `INSERT INTO class_sessions (course_id, created_by, title, session_date) VALUES ($1,$2,'S',current_date) RETURNING id`,
        )
      ).rows[0]!.id;
    case 'CHECK_IN_OPEN': {
      const ms = opts.deadlineInMs ?? 20 * 60_000;
      return (
        await db.pool.query<{ id: string }>(
          `INSERT INTO class_sessions (course_id, created_by, title, session_date, state, started_at, started_by, check_in_deadline)
           VALUES ($1,$2,'S',current_date,'CHECK_IN_OPEN', clock_timestamp() - interval '10 minutes', $2, clock_timestamp() + make_interval(secs => $3::float / 1000)) RETURNING id`,
          [course, by, ms],
        )
      ).rows[0]!.id;
    }
    case 'OPEN_EXPIRED':
      return (
        await q(`INSERT INTO class_sessions (course_id, created_by, title, session_date, state, started_at, started_by, check_in_deadline)
        VALUES ($1,$2,'S',current_date,'CHECK_IN_OPEN', now() - interval '40 minutes', $2, now() - interval '10 minutes') RETURNING id`)
      ).rows[0]!.id;
    case 'CHECK_IN_CLOSED':
      return (
        await q(`INSERT INTO class_sessions (course_id, created_by, title, session_date, state, started_at, started_by, check_in_deadline, check_in_closed_at, check_in_closed_reason)
        VALUES ($1,$2,'S',current_date,'CHECK_IN_CLOSED', now() - interval '40 minutes', $2, now() - interval '10 minutes', now() - interval '10 minutes','DEADLINE') RETURNING id`)
      ).rows[0]!.id;
    case 'ENDED':
      return (
        await q(`INSERT INTO class_sessions (course_id, created_by, title, session_date, state, started_at, started_by, check_in_deadline, check_in_closed_at, check_in_closed_reason, ended_at, ended_by)
        VALUES ($1,$2,'S',current_date,'ENDED', now() - interval '40 minutes', $2, now() - interval '10 minutes', now() - interval '10 minutes','DEADLINE', now() - interval '5 minutes', $2) RETURNING id`)
      ).rows[0]!.id;
  }
}

const row = async (id: string) =>
  (await db.pool.query('SELECT * FROM class_sessions WHERE id = $1', [id])).rows[0];

const auditFor = async (sessionId: string, action?: string) =>
  (
    await db.pool.query(
      `SELECT action, actor_type, class, summary FROM audit_events
        WHERE session_id = $1 AND ($2::text IS NULL OR action = $2) ORDER BY id`,
      [sessionId, action ?? null],
    )
  ).rows;

const url = (sessionId: string, action = '', course = courseId) =>
  `/courses/${course}/sessions/${sessionId}${action ? `/${action}` : ''}`;
const doPost = (path: string, body: unknown = {}, cookie = lecturer1.cookie) =>
  post(t.app, path, body, { cookie });
const deadlineOf = async (id: string): Promise<string> =>
  (await get(t.app, url(id), { cookie: lecturer1.cookie })).json().session.checkInDeadline;

describe('creating and listing sessions', () => {
  it('creates a NOT_STARTED session with no times set, and audits it', async () => {
    const res = await doPost(`/courses/${courseId}/sessions`, {
      title: '  Week 1 lecture  ',
      sessionDate: '2026-09-07',
    });
    expect(res.statusCode).toBe(201);
    const s = res.json().session;
    expect(s).toMatchObject({
      title: 'Week 1 lecture',
      sessionDate: '2026-09-07',
      state: 'NOT_STARTED',
      startedAt: null,
      checkInDeadline: null,
      endedAt: null,
    });
    const events = await auditFor(s.id, 'SESSION_CREATED');
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ actor_type: 'LECTURER', class: 'DOMAIN' });
  });

  it('rejects blank titles and impossible dates', async () => {
    expect((await doPost(`/courses/${courseId}/sessions`, { title: '   ' })).statusCode).toBe(400);
    expect(
      (await doPost(`/courses/${courseId}/sessions`, { title: 'x', sessionDate: '2026-02-31' }))
        .statusCode,
    ).toBe(400);
    expect(
      (await doPost(`/courses/${courseId}/sessions`, { title: 'x', sessionDate: 'tomorrow' }))
        .statusCode,
    ).toBe(400);
  });

  it("lists a course's sessions only, and hides sessions from other lecturers and courses", async () => {
    const mine = await seed('NOT_STARTED');
    const theirs = await seed('NOT_STARTED', { course: otherCourseId });
    const list = (
      await get(t.app, `/courses/${courseId}/sessions`, { cookie: lecturer1.cookie })
    ).json().sessions;
    expect(list.some((s: { id: string }) => s.id === mine)).toBe(true);
    expect(list.some((s: { id: string }) => s.id === theirs)).toBe(false);
    expect(
      (await get(t.app, `/courses/${courseId}/sessions`, { cookie: lecturer2.cookie })).statusCode,
    ).toBe(404);
    expect(
      (await get(t.app, `/courses/${courseId}/sessions`, { cookie: studentCookie })).statusCode,
    ).toBe(403);
  });

  it("treats another course's session id, or a malformed id, as not found", async () => {
    const theirs = await seed('NOT_STARTED', { course: otherCourseId });
    for (const id of [theirs, 'not-a-uuid']) {
      expect((await get(t.app, url(id), { cookie: lecturer1.cookie })).statusCode).toBe(404);
      expect((await doPost(url(id, 'start'))).statusCode).toBe(404);
      expect((await doPost(url(id, 'end'))).statusCode).toBe(404);
    }
    expect((await row(theirs)).state).toBe('NOT_STARTED'); // untouched
  });
});

describe('SES-01 starting opens check-in for exactly 30 minutes of database time', () => {
  it('sets started_at from the database clock and the deadline exactly 30 minutes later', async () => {
    const id = await seed('NOT_STARTED');
    const before = (await db.pool.query<{ t: Date }>('SELECT clock_timestamp() AS t')).rows[0]!.t;
    const res = await doPost(url(id, 'start'));
    const after = (await db.pool.query<{ t: Date }>('SELECT clock_timestamp() AS t')).rows[0]!.t;

    expect(res.statusCode).toBe(200);
    expect(res.json().session.state).toBe('CHECK_IN_OPEN');
    const r = (
      await db.pool.query<{ started_at: Date; window_ok: boolean; started_by: string }>(
        `SELECT started_at, (check_in_deadline - started_at = interval '30 minutes') AS window_ok, started_by
           FROM class_sessions WHERE id = $1`,
        [id],
      )
    ).rows[0]!;
    expect(r.window_ok).toBe(true);
    expect(r.started_at.getTime()).toBeGreaterThanOrEqual(before.getTime());
    expect(r.started_at.getTime()).toBeLessThanOrEqual(after.getTime());
    expect(r.started_by).toBe(lecturer1.id);
    expect(res.json().session.checkInDeadline).toBe(await deadlineOf(id));
  });

  it('records exactly one SESSION_STARTED audit event', async () => {
    const id = await seed('NOT_STARTED');
    await doPost(url(id, 'start'));
    const events = await auditFor(id, 'SESSION_STARTED');
    expect(events).toHaveLength(1);
    expect(events[0]!.summary).toEqual({ windowMinutes: 30 });
  });

  it('lets exactly one of ten simultaneous starts win', async () => {
    const id = await seed('NOT_STARTED');
    const results = await Promise.all(Array.from({ length: 10 }, () => doPost(url(id, 'start'))));
    expect(results.filter((r) => r.statusCode === 200)).toHaveLength(1);
    expect(results.filter((r) => r.statusCode === 409)).toHaveLength(9);
    expect(results.some((r) => r.statusCode >= 500)).toBe(false);
    expect(await auditFor(id, 'SESSION_STARTED')).toHaveLength(1);
  });

  it('does not let a student, an unassigned lecturer or an anonymous caller start it', async () => {
    const id = await seed('NOT_STARTED');
    expect((await doPost(url(id, 'start'), {}, studentCookie)).statusCode).toBe(403);
    expect((await doPost(url(id, 'start'), {}, lecturer2.cookie)).statusCode).toBe(404);
    expect((await post(t.app, url(id, 'start'), {})).statusCode).toBe(401);
    expect((await row(id)).state).toBe('NOT_STARTED');
  });
});

describe('SES-02 only legal transitions succeed through the API', () => {
  const table: Array<[Stored | 'OPEN_EXPIRED', 'start' | 'extend' | 'end', number]> = [
    ['NOT_STARTED', 'start', 200],
    ['NOT_STARTED', 'extend', 409],
    ['NOT_STARTED', 'end', 409],
    ['CHECK_IN_OPEN', 'start', 409],
    ['CHECK_IN_OPEN', 'extend', 200],
    ['CHECK_IN_OPEN', 'end', 200],
    ['OPEN_EXPIRED', 'start', 409],
    ['OPEN_EXPIRED', 'extend', 409],
    ['OPEN_EXPIRED', 'end', 200],
    ['CHECK_IN_CLOSED', 'start', 409],
    ['CHECK_IN_CLOSED', 'extend', 409],
    ['CHECK_IN_CLOSED', 'end', 200],
    ['ENDED', 'start', 409],
    ['ENDED', 'extend', 409],
    ['ENDED', 'end', 200],
  ];

  it.each(table)('%s + %s -> %i', async (from, action, expected) => {
    const id = await seed(from);
    const before = await row(id);
    const body =
      action === 'extend'
        ? {
            minutes: 5,
            reason: 'Class overran',
            expectedDeadline: (await deadlineOf(id)) ?? '2026-01-01T00:00:00Z',
          }
        : {};
    const res = await doPost(url(id, action), body);
    expect(res.statusCode).toBe(expected);
    if (expected === 409) {
      expect(res.json().error.code).toBe('INVALID_TRANSITION');
      expect(await row(id)).toEqual(before); // nothing changed
      expect(await auditFor(id)).toHaveLength(0); // and nothing was recorded
    }
  });
});

describe('SES-03 extensions are forward-only, bounded and recorded', () => {
  it('records previous deadline, new deadline, actor and reason; the deadline moves by exactly the amount', async () => {
    const id = await seed('NOT_STARTED');
    await doPost(url(id, 'start'));
    const prev = await deadlineOf(id);
    const res = await doPost(url(id, 'extend'), {
      minutes: 10,
      reason: '  Class overran  ',
      expectedDeadline: prev,
    });
    expect(res.statusCode).toBe(200);

    const ext = (
      await db.pool.query(
        `SELECT extended_by, reason,
              (new_deadline - previous_deadline = interval '10 minutes') AS exact,
              to_char(previous_deadline AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS prev_text
         FROM session_extensions WHERE session_id = $1`,
        [id],
      )
    ).rows;
    expect(ext).toHaveLength(1);
    expect(ext[0]).toMatchObject({
      extended_by: lecturer1.id,
      reason: 'Class overran',
      exact: true,
      prev_text: prev,
    });
    expect(res.json().session.extensions).toHaveLength(1);
    expect(res.json().session.checkInDeadline).not.toBe(prev);
    expect(res.json().session.state).toBe('CHECK_IN_OPEN');

    const events = await auditFor(id, 'SESSION_EXTENDED');
    expect(events).toHaveLength(1);
    expect(events[0]!.summary).toMatchObject({ minutes: 10 });
  });

  it('rejects zero, negative, fractional, oversized and malformed amounts and short reasons', async () => {
    const id = await seed('NOT_STARTED');
    await doPost(url(id, 'start'));
    const expectedDeadline = await deadlineOf(id);
    const ok = { minutes: 5, reason: 'Valid reason', expectedDeadline };
    for (const patch of [
      { minutes: 0 },
      { minutes: -5 },
      { minutes: 1.5 },
      { minutes: 121 },
      { minutes: '5' },
      { reason: 'no' },
      { reason: '   ' },
      { expectedDeadline: 'yesterday' },
      { expectedDeadline: undefined },
    ]) {
      const res = await doPost(url(id, 'extend'), { ...ok, ...patch });
      expect(res.statusCode, JSON.stringify(patch)).toBe(400);
    }
    expect(
      (await db.pool.query('SELECT 1 FROM session_extensions WHERE session_id = $1', [id]))
        .rowCount,
    ).toBe(0);
  });

  it('refuses to push the deadline more than 120 minutes ahead', async () => {
    const id = await seed('NOT_STARTED');
    await doPost(url(id, 'start'));
    const first = await doPost(url(id, 'extend'), {
      minutes: 90,
      reason: 'Exam overrun',
      expectedDeadline: await deadlineOf(id),
    });
    expect(first.statusCode).toBe(200); // 30 + 90 = 120 minutes from start
    const second = await doPost(url(id, 'extend'), {
      minutes: 10,
      reason: 'Even more',
      expectedDeadline: await deadlineOf(id),
    });
    expect(second.statusCode).toBe(400);
    expect(second.json().error.code).toBe('EXTENSION_TOO_FAR');
  });

  it('a double-submit applies once: the second request carries a stale deadline', async () => {
    const id = await seed('NOT_STARTED');
    await doPost(url(id, 'start'));
    const expectedDeadline = await deadlineOf(id);
    const body = { minutes: 5, reason: 'Double click', expectedDeadline };
    const results = await Promise.all([
      doPost(url(id, 'extend'), body),
      doPost(url(id, 'extend'), body),
      doPost(url(id, 'extend'), body),
    ]);
    expect(results.filter((r) => r.statusCode === 200)).toHaveLength(1);
    const stale = results.filter((r) => r.statusCode === 409);
    expect(stale).toHaveLength(2);
    expect(stale[0]!.json().error.code).toBe('STALE_DEADLINE');
    expect(
      (await db.pool.query('SELECT 1 FROM session_extensions WHERE session_id = $1', [id]))
        .rowCount,
    ).toBe(1);
  });

  it('does not extend after the deadline has passed, even before the sweeper runs', async () => {
    const id = await seed('OPEN_EXPIRED');
    const res = await doPost(url(id, 'extend'), {
      minutes: 5,
      reason: 'Too late',
      expectedDeadline: await deadlineOf(id),
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.state).toBe('CHECK_IN_CLOSED');
  });

  it('never lets the database accept a backwards extension', async () => {
    const id = await seed('CHECK_IN_OPEN');
    await expect(
      db.appPool.query(
        `UPDATE class_sessions SET check_in_deadline = check_in_deadline - interval '1 minute' WHERE id = $1`,
        [id],
      ),
    ).rejects.toMatchObject({ code: '23514' });
  });
});

describe('SES-04 ending is immediate and terminal', () => {
  it('ends an open session: check-in closes at the same instant', async () => {
    const id = await seed('NOT_STARTED');
    await doPost(url(id, 'start'));
    const res = await doPost(url(id, 'end'));
    expect(res.json().session.state).toBe('ENDED');
    const r = await row(id);
    expect(r.check_in_closed_reason).toBe('ENDED_BY_LECTURER');
    expect(r.check_in_closed_at.getTime()).toBe(r.ended_at.getTime());
    expect(r.ended_by).toBe(lecturer1.id);
    expect(r.check_in_closed_at.getTime()).toBeLessThan(r.check_in_deadline.getTime());
  });

  it('is terminal: nothing can start, extend or reopen it, and ending again is a silent no-op', async () => {
    const id = await seed('NOT_STARTED');
    await doPost(url(id, 'start'));
    await doPost(url(id, 'end'));
    const snapshot = await row(id);

    expect((await doPost(url(id, 'start'))).statusCode).toBe(409);
    expect(
      (
        await doPost(url(id, 'extend'), {
          minutes: 5,
          reason: 'Try again',
          expectedDeadline: await deadlineOf(id),
        })
      ).statusCode,
    ).toBe(409);
    const again = await doPost(url(id, 'end'));
    expect(again.statusCode).toBe(200);
    expect(await row(id)).toEqual(snapshot);
    expect(await auditFor(id, 'SESSION_ENDED')).toHaveLength(1);
    await expect(
      db.appPool.query(`UPDATE class_sessions SET state = 'CHECK_IN_OPEN' WHERE id = $1`, [id]),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('keeps the deadline as the close time when the window had already lapsed', async () => {
    const expired = await seed('OPEN_EXPIRED');
    await doPost(url(expired, 'end'));
    const r = await row(expired);
    expect(r.state).toBe('ENDED');
    expect(r.check_in_closed_reason).toBe('DEADLINE');
    expect(r.check_in_closed_at.getTime()).toBe(r.check_in_deadline.getTime());

    const closed = await seed('CHECK_IN_CLOSED');
    const before = await row(closed);
    await doPost(url(closed, 'end'));
    const after = await row(closed);
    expect(after.state).toBe('ENDED');
    expect(after.check_in_closed_at).toEqual(before.check_in_closed_at);
  });
});

describe('SES-05 the deadline closes check-in but leaves the session reviewable', () => {
  it('reports the session closed the moment the deadline passes, before any sweeper runs', async () => {
    const id = await seed('OPEN_EXPIRED');
    expect((await row(id)).state).toBe('CHECK_IN_OPEN'); // stored state not yet updated
    const view = (await get(t.app, url(id), { cookie: lecturer1.cookie })).json().session;
    expect(view.state).toBe('CHECK_IN_CLOSED');
    expect(view.checkInClosedAt).toBe((await row(id)).check_in_deadline.toISOString());
    const listed = (await get(t.app, `/courses/${courseId}/sessions`, { cookie: lecturer1.cookie }))
      .json()
      .sessions.find((s: { id: string }) => s.id === id);
    expect(listed.state).toBe('CHECK_IN_CLOSED');
  });

  it('the sweeper stores the closure at the deadline instant, audits it, and is idempotent', async () => {
    const expired = await seed('OPEN_EXPIRED');
    const live = await seed('CHECK_IN_OPEN');
    const closed = await closeExpiredSessions(db.appPool);
    expect(closed).toBeGreaterThanOrEqual(1);

    const r = await row(expired);
    expect(r.state).toBe('CHECK_IN_CLOSED');
    expect(r.check_in_closed_reason).toBe('DEADLINE');
    expect(r.check_in_closed_at.getTime()).toBe(r.check_in_deadline.getTime()); // not "when the job ran"
    expect((await row(live)).state).toBe('CHECK_IN_OPEN'); // untouched

    const events = await auditFor(expired, 'SESSION_CHECKIN_CLOSED');
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ actor_type: 'SYSTEM', class: 'DOMAIN' });
    expect(await closeExpiredSessions(db.appPool)).toBe(0);
    expect(await auditFor(expired, 'SESSION_CHECKIN_CLOSED')).toHaveLength(1);
  });

  it('a closed session can still be viewed and then ended; QR/check-in state never reopens', async () => {
    const id = await seed('CHECK_IN_CLOSED');
    expect((await get(t.app, url(id), { cookie: lecturer1.cookie })).statusCode).toBe(200);
    expect((await doPost(url(id, 'start'))).statusCode).toBe(409);
    expect((await doPost(url(id, 'end'))).json().session.state).toBe('ENDED');
  });
});

describe('CONC-04 extension, ending and the sweeper racing at the deadline', () => {
  it('extension vs sweeper: either extended and open, or closed with the deadline untouched; never both', async () => {
    const iterations = 24;
    const ids = await Promise.all(
      Array.from({ length: iterations }, () => seed('CHECK_IN_OPEN', { deadlineInMs: 350 })),
    );
    const originals = new Map<string, string>();
    for (const id of ids) originals.set(id, await deadlineOf(id));

    const outcomes = await Promise.all(
      ids.map(async (id, i) => {
        // Spread attempts across a window straddling the deadline.
        await new Promise((r) => setTimeout(r, 250 + ((i * 37) % 200)));
        const [ext] = await Promise.allSettled([
          extendSession(db.appPool, {
            courseId,
            sessionId: id,
            actorId: lecturer1.id,
            minutes: 5,
            reason: 'Race test',
            expectedDeadline: originals.get(id)!,
          }),
          closeExpiredSessions(db.appPool),
        ]);
        return { id, ext };
      }),
    );
    await closeExpiredSessions(db.appPool);

    let extended = 0;
    let closed = 0;
    for (const { id, ext } of outcomes) {
      const r = await row(id);
      const extensions = (
        await db.pool.query('SELECT 1 FROM session_extensions WHERE session_id = $1', [id])
      ).rowCount;
      if (ext.status === 'fulfilled') {
        extended += 1;
        expect(r.state).toBe('CHECK_IN_OPEN');
        expect(extensions).toBe(1);
        expect(r.check_in_deadline.getTime()).toBeGreaterThan(
          new Date(originals.get(id)!).getTime(),
        );
      } else {
        closed += 1;
        expect((ext.reason as SessionError).status).toBe(409);
        expect(r.state).toBe('CHECK_IN_CLOSED');
        expect(extensions).toBe(0);
        expect(r.check_in_closed_at.getTime()).toBe(r.check_in_deadline.getTime());
        expect(r.check_in_deadline.toISOString().slice(0, 19)).toBe(
          new Date(originals.get(id)!).toISOString().slice(0, 19),
        );
      }
    }
    expect(extended + closed).toBe(iterations);
  });

  it('ending vs sweeper at the deadline always ends cleanly with a consistent close time', async () => {
    const ids = await Promise.all(
      Array.from({ length: 20 }, () => seed('CHECK_IN_OPEN', { deadlineInMs: 300 })),
    );
    const results = await Promise.all(
      ids.map(async (id, i) => {
        await new Promise((r) => setTimeout(r, 220 + ((i * 29) % 160)));
        return Promise.allSettled([
          endSession(db.appPool, { courseId, sessionId: id, actorId: lecturer1.id }),
          closeExpiredSessions(db.appPool),
        ]);
      }),
    );
    for (const [end, sweep] of results) {
      expect(end!.status, String((end as PromiseRejectedResult).reason)).toBe('fulfilled');
      expect(sweep!.status).toBe('fulfilled');
    }
    for (const id of ids) {
      const r = await row(id);
      expect(r.state).toBe('ENDED');
      expect(['DEADLINE', 'ENDED_BY_LECTURER']).toContain(r.check_in_closed_reason);
      if (r.check_in_closed_reason === 'DEADLINE')
        expect(r.check_in_closed_at.getTime()).toBe(r.check_in_deadline.getTime());
      else expect(r.check_in_closed_at.getTime()).toBe(r.ended_at.getTime());
      expect(await auditFor(id, 'SESSION_ENDED')).toHaveLength(1);
    }
  });
});

describe('AUD-01 a state change and its audit event commit together or not at all', () => {
  async function withFailingAudit<T>(action: string, fn: () => Promise<T>): Promise<T> {
    await db.pool.query(
      `CREATE OR REPLACE FUNCTION fail_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'forced audit failure'; END $$`,
    );
    await db.pool.query(
      `CREATE TRIGGER fail_audit_trg BEFORE INSERT ON audit_events FOR EACH ROW WHEN (NEW.action = '${action}') EXECUTE FUNCTION fail_audit()`,
    );
    try {
      return await fn();
    } finally {
      await db.pool.query('DROP TRIGGER IF EXISTS fail_audit_trg ON audit_events');
    }
  }

  it('start: if the audit write fails, the session is not started', async () => {
    const id = await seed('NOT_STARTED');
    const res = await withFailingAudit('SESSION_STARTED', () => doPost(url(id, 'start')));
    expect(res.statusCode).toBe(500);
    const r = await row(id);
    expect(r).toMatchObject({ state: 'NOT_STARTED', started_at: null, check_in_deadline: null });
    expect(await auditFor(id)).toHaveLength(0);
  });

  it('extend: if the audit write fails, neither the deadline nor the extension row persists', async () => {
    const id = await seed('NOT_STARTED');
    await doPost(url(id, 'start'));
    const before = await row(id);
    const res = await withFailingAudit('SESSION_EXTENDED', async () =>
      doPost(url(id, 'extend'), {
        minutes: 5,
        reason: 'Will fail',
        expectedDeadline: await deadlineOf(id),
      }),
    );
    expect(res.statusCode).toBe(500);
    expect((await row(id)).check_in_deadline).toEqual(before.check_in_deadline);
    expect(
      (await db.pool.query('SELECT 1 FROM session_extensions WHERE session_id = $1', [id]))
        .rowCount,
    ).toBe(0);
  });

  it('end: if the audit write fails, the session is still open', async () => {
    const id = await seed('NOT_STARTED');
    await doPost(url(id, 'start'));
    const res = await withFailingAudit('SESSION_ENDED', () => doPost(url(id, 'end')));
    expect(res.statusCode).toBe(500);
    expect(await row(id)).toMatchObject({ state: 'CHECK_IN_OPEN', ended_at: null });
  });

  it('sweeper: if the audit write fails, the closure is rolled back and retried next time', async () => {
    const id = await seed('OPEN_EXPIRED');
    await expect(
      withFailingAudit('SESSION_CHECKIN_CLOSED', () => closeExpiredSessions(db.appPool)),
    ).rejects.toThrow(/forced audit failure/);
    expect((await row(id)).state).toBe('CHECK_IN_OPEN');
    await closeExpiredSessions(db.appPool);
    expect((await row(id)).state).toBe('CHECK_IN_CLOSED');
    expect(await auditFor(id, 'SESSION_CHECKIN_CLOSED')).toHaveLength(1);
  });

  it('records the full lifecycle in order, as the right actors, without personal data', async () => {
    const created = (await doPost(`/courses/${courseId}/sessions`, { title: 'Lifecycle' })).json()
      .session.id;
    await doPost(url(created, 'start'));
    await doPost(url(created, 'extend'), {
      minutes: 5,
      reason: 'Overran',
      expectedDeadline: await deadlineOf(created),
    });
    await doPost(url(created, 'end'));
    const events = await auditFor(created);
    expect(events.map((e) => e.action)).toEqual([
      'SESSION_CREATED',
      'SESSION_STARTED',
      'SESSION_EXTENDED',
      'SESSION_ENDED',
    ]);
    expect(events.every((e) => e.actor_type === 'LECTURER' && e.class === 'DOMAIN')).toBe(true);
    const serialised = JSON.stringify(events.map((e) => e.summary));
    expect(serialised).not.toContain('Overran'); // free text stays in the extension record, not the log
  });
});

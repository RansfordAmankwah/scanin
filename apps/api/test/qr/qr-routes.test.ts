import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import { MemoryMailer } from '../../src/auth/mailer.js';
import { assignLecturer, createCourse, createTerm } from '../../src/operator/commands.js';
import { checkTokenTimes, parseKeyring, verifyToken } from '../../src/qr/token.js';
import {
  APP_ORIGIN,
  TEST_CONFIG,
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
const operator = 'qr-test';
const keyring = parseKeyring(TEST_CONFIG.QR_KEYS, TEST_CONFIG.QR_ACTIVE_KID);

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
    await createCourse(db.operatorPool, { operator, term: 'T1', code: 'Q1', title: 'Q1' })
  ).id;
  otherCourseId = (
    await createCourse(db.operatorPool, { operator, term: 'T1', code: 'Q2', title: 'Q2' })
  ).id;
  await assignLecturer(db.operatorPool, {
    operator,
    term: 'T1',
    courseCode: 'Q1',
    lecturerEmail: 'lec1@school.test',
  });
  await assignLecturer(db.operatorPool, {
    operator,
    term: 'T1',
    courseCode: 'Q2',
    lecturerEmail: 'lec2@school.test',
  });
});

afterAll(async () => {
  await t?.close();
  await db?.drop();
});

/** A session in the requested state, created through the real API where possible. */
async function sessionIn(
  state: 'NOT_STARTED' | 'OPEN' | 'EXPIRED' | 'ENDED',
  course = courseId,
): Promise<string> {
  const cookie = course === courseId ? lecturer1.cookie : lecturer2.cookie;
  const created = await post(
    t.app,
    `/courses/${course}/sessions`,
    { title: 'QR session' },
    { cookie },
  );
  const id = created.json().session.id as string;
  if (state === 'NOT_STARTED') return id;
  await post(t.app, `/courses/${course}/sessions/${id}/start`, {}, { cookie });
  if (state === 'ENDED') await post(t.app, `/courses/${course}/sessions/${id}/end`, {}, { cookie });
  if (state === 'EXPIRED') {
    // Move the whole window into the past (owner connection; the app could not do this).
    await db.pool.query(`ALTER TABLE class_sessions DISABLE TRIGGER class_sessions_guard_trg`);
    await db.pool.query(
      `UPDATE class_sessions SET started_at = now() - interval '40 minutes', check_in_deadline = now() - interval '10 minutes' WHERE id = $1`,
      [id],
    );
    await db.pool.query(`ALTER TABLE class_sessions ENABLE TRIGGER class_sessions_guard_trg`);
  }
  return id;
}

const qrUrl = (id: string, course = courseId) => `/courses/${course}/sessions/${id}/qr`;
const mint = (id: string, cookie = lecturer1.cookie, course = courseId) =>
  get(t.app, qrUrl(id, course), { cookie });
const row = async (id: string) =>
  (await db.pool.query('SELECT * FROM class_sessions WHERE id = $1', [id])).rows[0];

describe('minting a code for the lecturer display', () => {
  it('returns a signed three-minute code bound to the session, issued at database time', async () => {
    const id = await sessionIn('OPEN');
    const before = (
      await db.pool.query<{ ms: string }>(
        `SELECT floor(extract(epoch FROM clock_timestamp())*1000)::bigint AS ms`,
      )
    ).rows[0]!.ms;
    const res = await mint(id);
    const after = (
      await db.pool.query<{ ms: string }>(
        `SELECT floor(extract(epoch FROM clock_timestamp())*1000)::bigint AS ms`,
      )
    ).rows[0]!.ms;

    expect(res.statusCode).toBe(200);
    const body = res.json();
    const verified = verifyToken(keyring, body.token);
    expect(verified.ok).toBe(true);
    if (!verified.ok) return;
    expect(verified.payload.sessionId).toBe(id);
    expect(verified.payload.kid).toBe('k1');
    expect(verified.payload.issuedAtMs).toBeGreaterThanOrEqual(Number(before));
    expect(verified.payload.issuedAtMs).toBeLessThanOrEqual(Number(after));
    expect(verified.payload.expiresAtMs - verified.payload.issuedAtMs).toBe(180_000);
    expect(body.issuedAt).toBe(new Date(verified.payload.issuedAtMs).toISOString());
    expect(body.expiresAt).toBe(new Date(verified.payload.expiresAtMs).toISOString());
    expect(body.refreshAfterSeconds).toBe(30);
    expect(body.qrUrl).toBe(`${APP_ORIGIN}/c#t=${body.token}`);
    expect(body.checkInDeadline).toMatch(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/);
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('hands out different codes on each refresh, all valid at the same time', async () => {
    const id = await sessionIn('OPEN');
    const first = (await mint(id)).json();
    const second = (await mint(id)).json();
    expect(first.token).not.toBe(second.token);
    const now = Date.now();
    for (const body of [first, second]) {
      const v = verifyToken(keyring, body.token);
      expect(v.ok && checkTokenTimes(v.payload, now, null)).toBe('OK');
    }
  });

  it.each([
    ['not started', 'NOT_STARTED', 'NOT_STARTED'],
    ['past its deadline', 'EXPIRED', 'CHECK_IN_CLOSED'],
    ['ended', 'ENDED', 'ENDED'],
  ] as const)('refuses to issue a code when the session is %s', async (_label, setup, state) => {
    const id = await sessionIn(setup);
    const res = await mint(id);
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatchObject({ code: 'CHECK_IN_NOT_OPEN', state });
    expect(res.body).not.toContain('ST1.');
  });
});

describe('QR-04 refreshing never changes session state or deadline', () => {
  it('leaves the session row byte-identical after many mints, and writes no extension or audit', async () => {
    const id = await sessionIn('OPEN');
    const before = await row(id);
    const auditBefore = (await db.pool.query('SELECT count(*)::int AS n FROM audit_events')).rows[0]
      .n;

    for (let i = 0; i < 12; i++) expect((await mint(id)).statusCode).toBe(200);

    expect(await row(id)).toEqual(before);
    expect((await row(id)).qr_not_before).toBeNull();
    expect(
      (await db.pool.query('SELECT 1 FROM session_extensions WHERE session_id = $1', [id]))
        .rowCount,
    ).toBe(0);
    expect((await db.pool.query('SELECT count(*)::int AS n FROM audit_events')).rows[0].n).toBe(
      auditBefore,
    );
  });

  it('cannot reopen a closed session or extend its deadline by asking for codes', async () => {
    const id = await sessionIn('EXPIRED');
    const before = await row(id);
    for (let i = 0; i < 3; i++) expect((await mint(id)).statusCode).toBe(409);
    expect(await row(id)).toEqual(before);
  });
});

describe('QR-07 invalidating issued codes', () => {
  it('rejects codes minted before the mark, keeps the deadline, and new codes work', async () => {
    const id = await sessionIn('OPEN');
    const old = (await mint(id)).json();
    await new Promise((r) => setTimeout(r, 25));
    const before = await row(id);

    const res = await post(t.app, `${qrUrl(id)}/invalidate`, {}, { cookie: lecturer1.cookie });
    expect(res.statusCode).toBe(200);
    await new Promise((r) => setTimeout(r, 25));
    const fresh = (await mint(id)).json();

    const after = await row(id);
    expect(after.qr_not_before).not.toBeNull();
    expect(after.check_in_deadline).toEqual(before.check_in_deadline); // window unchanged
    expect(after.state).toBe('CHECK_IN_OPEN');
    expect(after.started_at).toEqual(before.started_at);

    const mark = after.qr_not_before.getTime();
    const now = Date.now();
    const oldPayload = verifyToken(keyring, old.token);
    const freshPayload = verifyToken(keyring, fresh.token);
    expect(oldPayload.ok && checkTokenTimes(oldPayload.payload, now, mark)).toBe('REVOKED');
    expect(freshPayload.ok && checkTokenTimes(freshPayload.payload, now, mark)).toBe('OK');
  });

  it('audits the invalidation and only works while check-in is open', async () => {
    const id = await sessionIn('OPEN');
    await post(t.app, `${qrUrl(id)}/invalidate`, {}, { cookie: lecturer1.cookie });
    const events = (
      await db.pool.query(
        `SELECT actor_type, class FROM audit_events WHERE session_id = $1 AND action = 'QR_CODES_INVALIDATED'`,
        [id],
      )
    ).rows;
    expect(events).toEqual([{ actor_type: 'LECTURER', class: 'DOMAIN' }]);

    for (const state of ['NOT_STARTED', 'EXPIRED', 'ENDED'] as const) {
      const other = await sessionIn(state);
      const res = await post(t.app, `${qrUrl(other)}/invalidate`, {}, { cookie: lecturer1.cookie });
      expect(res.statusCode, state).toBe(409);
      expect((await row(other)).qr_not_before).toBeNull();
    }
  });

  it('only ever moves the mark forward, even across repeated invalidations', async () => {
    const id = await sessionIn('OPEN');
    await post(t.app, `${qrUrl(id)}/invalidate`, {}, { cookie: lecturer1.cookie });
    const first = (await row(id)).qr_not_before.getTime();
    await new Promise((r) => setTimeout(r, 10));
    await post(t.app, `${qrUrl(id)}/invalidate`, {}, { cookie: lecturer1.cookie });
    expect((await row(id)).qr_not_before.getTime()).toBeGreaterThan(first);
    await expect(
      db.appPool.query(
        `UPDATE class_sessions SET qr_not_before = qr_not_before - interval '1 hour' WHERE id = $1`,
        [id],
      ),
    ).rejects.toMatchObject({ code: '23514' });
  });
});

describe("access to codes is limited to the session's lecturer", () => {
  it("refuses students, other lecturers, anonymous callers, other courses' sessions and bad ids", async () => {
    const id = await sessionIn('OPEN');
    const theirs = await sessionIn('OPEN', otherCourseId);
    expect((await mint(id, studentCookie)).statusCode).toBe(403);
    expect((await mint(id, lecturer2.cookie)).statusCode).toBe(404);
    expect((await get(t.app, qrUrl(id))).statusCode).toBe(401);
    expect((await mint(theirs, lecturer1.cookie, courseId)).statusCode).toBe(404); // right lecturer, wrong course
    expect((await mint('not-a-uuid')).statusCode).toBe(404);
    for (const res of [await mint(id, studentCookie), await mint(id, lecturer2.cookie)]) {
      expect(res.body).not.toContain('ST1.');
    }
    const inv = await post(t.app, `${qrUrl(id)}/invalidate`, {}, { cookie: lecturer2.cookie });
    expect(inv.statusCode).toBe(404);
    expect((await row(id)).qr_not_before).toBeNull();
  });

  it('rate-limits minting per lecturer and session without affecting other sessions', async () => {
    const busy = await sessionIn('OPEN');
    const calm = await sessionIn('OPEN');
    let limited: Awaited<ReturnType<typeof mint>> | undefined;
    for (let i = 0; i < 30 && !limited; i++) {
      const res = await mint(busy);
      if (res.statusCode === 429) limited = res;
    }
    expect(limited?.statusCode).toBe(429);
    expect(limited?.headers['retry-after']).toBeDefined();
    expect(limited?.body).not.toContain('ST1.');
    expect((await mint(calm)).statusCode).toBe(200);
  });
});

describe('QR-08 codes and keys never reach logs', () => {
  it('keeps issued tokens, token prefixes and key material out of the log output', async () => {
    const id = await sessionIn('OPEN');
    const issued: string[] = [];
    for (let i = 0; i < 3; i++) issued.push((await mint(id)).json().token);
    await post(t.app, `${qrUrl(id)}/invalidate`, {}, { cookie: lecturer1.cookie });
    await mint('not-a-uuid');
    await mint(id, lecturer2.cookie);
    await get(t.app, qrUrl(id));

    const logs = t.logs();
    expect(logs.length).toBeGreaterThan(0);
    for (const token of issued) {
      expect(logs).not.toContain(token);
      expect(logs).not.toContain(token.split('.')[2]); // not even the payload part
    }
    expect(logs).not.toContain('ST1.');
    expect(logs).not.toContain('A'.repeat(43)); // key k1
    expect(logs).not.toContain('B'.repeat(43)); // key k0
    expect(logs).not.toContain(TEST_CONFIG.QR_KEYS);
  });

  it('never puts key material in any API response', async () => {
    const id = await sessionIn('OPEN');
    const bodies = [
      (await mint(id)).body,
      (await mint(id, studentCookie)).body,
      (await mint(id, lecturer2.cookie)).body,
    ];
    for (const body of bodies) {
      expect(body).not.toContain('A'.repeat(43));
      expect(body).not.toContain('B'.repeat(43));
    }
  });

  it('never stores a code or key in the database', async () => {
    const id = await sessionIn('OPEN');
    const token = (await mint(id)).json().token as string;
    const { rows } = await db.pool.query(
      `SELECT count(*)::int AS n FROM audit_events WHERE summary::text LIKE '%' || $1 || '%'`,
      [token.split('.')[2]],
    );
    expect(rows[0].n).toBe(0);
  });
});

describe('signing key configuration is validated at start-up', () => {
  it.each([
    ['a key that is too short', { QR_KEYS: 'k1:tooshort', QR_ACTIVE_KID: 'k1' }],
    ['an active key that is not configured', { QR_ACTIVE_KID: 'missing' }],
    ['no keys at all', { QR_KEYS: ',' }],
  ])('refuses to build the app with %s', async (_label, patch) => {
    await expect(
      buildApp({
        config: { ...TEST_CONFIG, ...patch },
        pool: db.appPool,
        mailer: new MemoryMailer(),
      }),
    ).rejects.toThrow();
  });
});

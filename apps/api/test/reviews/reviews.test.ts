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
const operator = 'review-test';
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
  lecturer1 = await createLecturerSession(db, t.app, 'lec1@school.test', 'Dr One');
  lecturer2 = await createLecturerSession(db, t.app, 'lec2@school.test', 'Dr Two');
});

afterAll(async () => {
  await t?.close();
  await db?.drop();
});

const WHY = 'Checked against the paper sign-in sheet';

async function newCourse(): Promise<string> {
  courseSeq += 1;
  const code = `R${courseSeq}`;
  const { id } = await createCourse(db.operatorPool, { operator, term: 'T1', code, title: code });
  await assignLecturer(db.operatorPool, {
    operator,
    term: 'T1',
    courseCode: code,
    lecturerEmail: 'lec1@school.test',
  });
  return id;
}
const students = (n: number): Promise<BulkStudent[]> => createBulkStudents(db, n);
const L1 = (path: string, body: unknown = {}) =>
  post(t.app, path, body, { cookie: lecturer1.cookie });
const G1 = (path: string) => get(t.app, path, { cookie: lecturer1.cookie });

async function importRoster(course: string, csv: string) {
  const preview = await L1(`/courses/${course}/roster/preview`, { csv });
  await L1(`/courses/${course}/roster/apply`, {
    csv,
    previewToken: preview.json().previewToken,
    retireEntryIds: [],
  });
}
const entryOf = async (course: string, studentId: string): Promise<string> =>
  (
    await db.pool.query<{ id: string }>(
      'SELECT id FROM roster_entries WHERE course_id = $1 AND student_id_norm = $2 AND retired_at IS NULL',
      [course, studentId],
    )
  ).rows[0]!.id;

const linkRow = async (id: string) =>
  (await db.pool.query('SELECT * FROM roster_links WHERE id = $1', [id])).rows[0];
const auditCount = async (action: string, entity?: string) =>
  (
    await db.pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM audit_events WHERE action = $1 AND ($2::text IS NULL OR entity_id = $2)`,
      [action, entity ?? null],
    )
  ).rows[0]!.n;

async function checkInToken(sessionId: string): Promise<string> {
  const now = Number(
    (
      await db.pool.query<{ ms: string }>(
        `SELECT floor(extract(epoch FROM clock_timestamp())*1000)::bigint AS ms`,
      )
    ).rows[0]!.ms,
  );
  return mintToken(keyring, sessionId, now).token;
}
async function scan(s: BulkStudent, sessionId: string) {
  return post(
    t.app,
    '/checkins',
    { token: await checkInToken(sessionId), clientAttemptId: randomUUID(), deviceId: randomUUID() },
    { cookie: s.cookie, ip: freshIp() },
  );
}
async function openSession(course: string): Promise<string> {
  const id = (await L1(`/courses/${course}/sessions`, { title: 'Lecture' })).json().session
    .id as string;
  await L1(`/courses/${course}/sessions/${id}/start`);
  return id;
}
/** A student with a checked-in attendance record in a fresh open session. */
async function attended(course: string, sessionId?: string) {
  const [s] = await students(1);
  const session = sessionId ?? (await openSession(course));
  await scan(s!, session);
  const attendanceId = (
    await db.pool.query<{ id: string }>(
      'SELECT id FROM attendance_records WHERE session_id = $1 AND student_id = $2',
      [session, s!.id],
    )
  ).rows[0]!.id;
  return { s: s!, session, attendanceId };
}
const att = (course: string, session: string, id: string, tail: string) =>
  `/courses/${course}/sessions/${session}/attendance/${id}${tail}`;
const statusOf = async (id: string) =>
  (
    await db.pool.query(
      'SELECT status::text AS status, current_rev_no FROM attendance_records WHERE id = $1',
      [id],
    )
  ).rows[0];
const revisions = async (id: string) =>
  (
    await db.pool.query(
      'SELECT rev_no, change_kind::text AS kind, from_status::text AS from_status, to_status::text AS to_status, reason_category::text AS category, explanation, actor_user_id FROM attendance_revisions WHERE attendance_id = $1 ORDER BY rev_no',
      [id],
    )
  ).rows;
const countsFor = async (course: string, session: string) =>
  (await G1(`/courses/${course}/sessions/${session}/attendance`)).json().counts;

describe('association decisions: legal transitions', () => {
  const states = ['PROVISIONAL', 'REVIEW_REQUIRED', 'CONFIRMED', 'REJECTED'] as const;
  const decisions = ['CONFIRM', 'KEEP_PROVISIONAL', 'REJECT', 'MARK_REVIEW_REQUIRED'] as const;
  const legal: Record<(typeof decisions)[number], readonly string[]> = {
    CONFIRM: ['PROVISIONAL', 'REVIEW_REQUIRED', 'REJECTED'],
    KEEP_PROVISIONAL: ['PROVISIONAL', 'REVIEW_REQUIRED'],
    REJECT: ['PROVISIONAL', 'REVIEW_REQUIRED'],
    MARK_REVIEW_REQUIRED: ['PROVISIONAL', 'CONFIRMED', 'REJECTED'],
  };
  const target = {
    CONFIRM: 'CONFIRMED',
    KEEP_PROVISIONAL: 'PROVISIONAL',
    REJECT: 'REJECTED',
    MARK_REVIEW_REQUIRED: 'REVIEW_REQUIRED',
  } as const;

  for (const from of states) {
    for (const decision of decisions) {
      const ok = legal[decision].includes(from);
      it(`${from} + ${decision} is ${ok ? 'allowed' : 'refused'}`, async () => {
        const course = await newCourse();
        const [s] = await students(1);
        const link = await createLink(db.pool, course, s!.id, { state: from });
        const res = await L1(`/courses/${course}/links/${link}/decision`, {
          decision,
          explanation: WHY,
          ...(decision === 'CONFIRM' ? { basis: 'LECTURER_ENROLLMENT_CONFIRMED' } : {}),
        });
        if (ok) {
          expect(res.statusCode).toBe(200);
          expect((await linkRow(link)).state).toBe(target[decision]);
        } else {
          expect(res.statusCode).toBe(409);
          expect(res.json().error.code).toBe('INVALID_TRANSITION');
          expect((await linkRow(link)).state).toBe(from);
          expect((await linkRow(link)).current_review_no).toBe(1); // nothing recorded
        }
      });
    }
  }
});

describe('association decisions: what they record', () => {
  it('confirming identity against a roster entry records who, why, and from/to, scoped to this course', async () => {
    const course = await newCourse();
    const other = await newCourse();
    const [s] = await students(1);
    await importRoster(course, 'student_id,full_name\nOFFICIAL-7,Kwame Official\n');
    const link = await createLink(db.pool, course, s!.id, { state: 'REVIEW_REQUIRED' });
    const otherLink = await createLink(db.pool, other, s!.id, { state: 'REVIEW_REQUIRED' });
    const entry = await entryOf(course, 'OFFICIAL-7');

    const res = await L1(`/courses/${course}/links/${link}/decision`, {
      decision: 'CONFIRM',
      basis: 'LECTURER_IDENTITY_CONFIRMED',
      entryId: entry,
      explanation: 'I know this student from tutorials',
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      state: 'CONFIRMED',
      basis: 'LECTURER_IDENTITY_CONFIRMED',
      entryId: entry,
      reviewNo: 2,
    });

    const row = await linkRow(link);
    expect(row).toMatchObject({
      state: 'CONFIRMED',
      confirmed_basis: 'LECTURER_IDENTITY_CONFIRMED',
      roster_entry_id: entry,
      current_review_no: 2,
    });
    const review = (
      await db.pool.query('SELECT * FROM identity_reviews WHERE link_id = $1 AND review_no = 2', [
        link,
      ])
    ).rows[0];
    expect(review).toMatchObject({
      review_kind: 'IDENTITY',
      decision: 'CONFIRM',
      from_state: 'REVIEW_REQUIRED',
      to_state: 'CONFIRMED',
      actor_user_id: lecturer1.id,
      explanation: 'I know this student from tutorials',
      basis: 'LECTURER_IDENTITY_CONFIRMED',
      to_entry_id: entry,
    });
    // ID-06: the same student's association in another course is untouched.
    expect(await linkRow(otherLink)).toMatchObject({
      state: 'REVIEW_REQUIRED',
      roster_entry_id: null,
      confirmed_basis: null,
      current_review_no: 1,
    });
  });

  it('confirming enrollment for a student who is not on the list needs no roster entry', async () => {
    const course = await newCourse();
    const [s] = await students(1);
    const link = await createLink(db.pool, course, s!.id, { state: 'REVIEW_REQUIRED' });
    const res = await L1(`/courses/${course}/links/${link}/decision`, {
      decision: 'CONFIRM',
      basis: 'LECTURER_ENROLLMENT_CONFIRMED',
      explanation: 'Late enrollee, confirmed by the registry office',
    });
    expect(res.statusCode).toBe(200);
    expect(await linkRow(link)).toMatchObject({
      state: 'CONFIRMED',
      roster_entry_id: null,
      confirmed_basis: 'LECTURER_ENROLLMENT_CONFIRMED',
    });
    expect(
      (
        await db.pool.query(
          `SELECT review_kind::text AS k FROM identity_reviews WHERE link_id = $1 AND review_no = 2`,
          [link],
        )
      ).rows[0].k,
    ).toBe('ENROLLMENT');
  });

  it('requires a basis to confirm and a written explanation for every decision', async () => {
    const course = await newCourse();
    const [s] = await students(1);
    const link = await createLink(db.pool, course, s!.id, { state: 'REVIEW_REQUIRED' });
    const attempt = (body: object) => L1(`/courses/${course}/links/${link}/decision`, body);
    expect((await attempt({ decision: 'CONFIRM', explanation: WHY })).json().error.code).toBe(
      'BASIS_REQUIRED',
    );
    for (const explanation of [undefined, '', '   ', 'too short']) {
      const res = await attempt({
        decision: 'REJECT',
        ...(explanation === undefined ? {} : { explanation }),
      });
      expect(res.statusCode, String(explanation)).toBe(400);
    }
    expect((await attempt({ decision: 'ERASE', explanation: WHY })).statusCode).toBe(400);
    expect(
      (await attempt({ decision: 'CONFIRM', basis: 'ROSTER_ID_MATCH', explanation: WHY }))
        .statusCode,
    ).toBe(400); // only a lecturer's bases may be chosen
    expect(await linkRow(link)).toMatchObject({ state: 'REVIEW_REQUIRED', current_review_no: 1 });
  });

  it('refuses entries that are invalid, retired, from another course, or held by someone else', async () => {
    const course = await newCourse();
    const other = await newCourse();
    const [holder, claimant] = await students(2);
    await importRoster(course, 'student_id,full_name\nHELD-1,Held Person\n');
    await importRoster(other, 'student_id,full_name\nELSEWHERE-1,Other Course\n');
    const heldEntry = await entryOf(course, 'HELD-1');
    const holderLink = await createLink(db.pool, course, holder!.id, { state: 'REVIEW_REQUIRED' });
    await db.pool.query('UPDATE roster_links SET roster_entry_id = $1 WHERE id = $2', [
      heldEntry,
      holderLink,
    ]); // downgraded holder keeps the entry (owner connection)
    const claimantLink = await createLink(db.pool, course, claimant!.id, {
      state: 'REVIEW_REQUIRED',
    });
    const confirm = (entryId: string) =>
      L1(`/courses/${course}/links/${claimantLink}/decision`, {
        decision: 'CONFIRM',
        basis: 'LECTURER_IDENTITY_CONFIRMED',
        entryId,
        explanation: WHY,
      });

    const held = await confirm(heldEntry);
    expect(held.statusCode).toBe(409);
    expect(held.json().error).toMatchObject({ code: 'ENTRY_HELD', heldByLinkId: holderLink });
    expect((await confirm(await entryOf(other, 'ELSEWHERE-1'))).json().error.code).toBe(
      'INVALID_ENTRY',
    );
    expect((await confirm(randomUUID())).json().error.code).toBe('INVALID_ENTRY');
    expect((await linkRow(claimantLink)).roster_entry_id).toBeNull();
  });
});

describe('ID-04 resolving a conflicting claim is explicit, one step at a time, and merges nothing', () => {
  it('rejects the wrong holder, then confirms the right student; the conflict flag is resolved separately', async () => {
    const course = await newCourse();
    const [squatter, rightful] = await students(2);
    // The squatter matched the entry by verified e-mail; the rightful student has the exact ID.
    await db.pool.query(
      `UPDATE users SET email = 'shared@school.test', email_verified_at = now() WHERE id = $1`,
      [squatter!.id],
    );
    await importRoster(
      course,
      `student_id,full_name,email\n${rightful!.studentId},Rightful Student,shared@school.test\n`,
    );
    const session = await openSession(course);
    await scan(squatter!, session);
    await scan(rightful!, session);

    const squatterLink = (
      await db.pool.query<{ id: string }>(
        'SELECT id FROM roster_links WHERE course_id = $1 AND student_id = $2',
        [course, squatter!.id],
      )
    ).rows[0]!.id;
    const rightfulLink = (
      await db.pool.query<{ id: string }>(
        'SELECT id FROM roster_links WHERE course_id = $1 AND student_id = $2',
        [course, rightful!.id],
      )
    ).rows[0]!.id;
    const entry = await entryOf(course, rightful!.studentId);
    const flagId = (
      await db.pool.query<{ id: string }>(
        `SELECT id FROM investigation_flags WHERE course_id = $1 AND kind = 'CONFLICTING_STUDENT_ID'`,
        [course],
      )
    ).rows[0]!.id;

    // Whoever holds the entry, both are in the queue and neither is confirmed.
    const queue = (await G1(`/courses/${course}/review-queue`)).json();
    expect(queue.links.map((l: { state: string }) => l.state)).toEqual([
      'REVIEW_REQUIRED',
      'REVIEW_REQUIRED',
    ]);
    expect(queue.flags.map((f: { kind: string }) => f.kind)).toEqual(['CONFLICTING_STUDENT_ID']);

    // Confirming the rightful student first is refused while the other still holds the entry.
    const holderId = (
      await db.pool.query<{ student_id: string }>(
        'SELECT student_id FROM roster_links WHERE roster_entry_id = $1',
        [entry],
      )
    ).rows[0]!.student_id;
    const [wrongLink, rightLink] =
      holderId === squatter!.id ? [squatterLink, rightfulLink] : [rightfulLink, squatterLink];
    const blocked = await L1(`/courses/${course}/links/${rightfulLink}/decision`, {
      decision: 'CONFIRM',
      basis: 'LECTURER_IDENTITY_CONFIRMED',
      entryId: entry,
      explanation: WHY,
    });
    if (holderId === squatter!.id) {
      expect(blocked.statusCode).toBe(409);
      const rejected = await L1(`/courses/${course}/links/${wrongLink}/decision`, {
        decision: 'REJECT',
        explanation: 'Not the owner of this student ID',
        flagId,
      });
      expect(rejected.statusCode).toBe(200);
      expect((await linkRow(wrongLink)).roster_entry_id).toBeNull(); // entry released
    }
    const confirmed = await L1(`/courses/${course}/links/${rightLink}/decision`, {
      decision: 'CONFIRM',
      basis: 'LECTURER_IDENTITY_CONFIRMED',
      entryId: entry,
      explanation: 'Verified student card in person',
    });
    expect(confirmed.statusCode).toBe(200);

    // Exactly one holder; the other account is rejected, not merged or deleted.
    const holders = (
      await db.pool.query(
        `SELECT state::text AS state, student_id FROM roster_links WHERE roster_entry_id = $1 AND state <> 'REJECTED'`,
        [entry],
      )
    ).rows;
    expect(holders).toHaveLength(1);
    expect(holders[0].state).toBe('CONFIRMED');
    expect(
      (
        await db.pool.query(`SELECT count(*)::int AS n FROM users WHERE id IN ($1, $2)`, [
          squatter!.id,
          rightful!.id,
        ])
      ).rows[0].n,
    ).toBe(2);

    // The flag is still open: deciding who holds the entry did not resolve the concern.
    expect(
      (
        await db.pool.query('SELECT state::text AS state FROM investigation_flags WHERE id = $1', [
          flagId,
        ])
      ).rows[0].state,
    ).toBe('OPEN');
    const done = await L1(`/courses/${course}/flags/${flagId}/transition`, { to: 'UNDER_REVIEW' });
    expect(done.statusCode).toBe(200);
    // Both attendance records remain; deciding the association did not invalidate anything.
    const counts = await countsFor(course, session);
    expect(counts.invalidated).toBe(0);
    expect(counts.presentTotal).toBe(2);
  });

  it("two lecturers' decisions racing for the same entry: exactly one wins, no errors", async () => {
    const course = await newCourse();
    const [a, b] = await students(2);
    await importRoster(course, 'student_id,full_name\nRACE-ENTRY,Race Entry\n');
    const entry = await entryOf(course, 'RACE-ENTRY');
    const la = await createLink(db.pool, course, a!.id, { state: 'REVIEW_REQUIRED' });
    const lb = await createLink(db.pool, course, b!.id, { state: 'REVIEW_REQUIRED' });
    const results = await Promise.all(
      [la, lb].map((l) =>
        L1(`/courses/${course}/links/${l}/decision`, {
          decision: 'CONFIRM',
          basis: 'LECTURER_IDENTITY_CONFIRMED',
          entryId: entry,
          explanation: WHY,
        }),
      ),
    );
    expect(results.map((r) => r.statusCode).sort()).toEqual([200, 409]);
    expect(results.find((r) => r.statusCode === 409)!.json().error.code).toBe('ENTRY_HELD');
  });

  it('the same decision submitted several times at once applies exactly once', async () => {
    const course = await newCourse();
    const [s] = await students(1);
    const link = await createLink(db.pool, course, s!.id, { state: 'REVIEW_REQUIRED' });
    const results = await Promise.all(
      [1, 2, 3, 4].map(() =>
        L1(`/courses/${course}/links/${link}/decision`, { decision: 'REJECT', explanation: WHY }),
      ),
    );
    expect(results.map((r) => r.statusCode).sort()).toEqual([200, 409, 409, 409]);
    expect(results.find((r) => r.statusCode === 409)!.json().error.code).toBe('INVALID_TRANSITION');
    expect((await linkRow(link)).current_review_no).toBe(2); // exactly one review recorded
  });

  it('a rejected match can later be confirmed: rejection is a recorded step, not a dead end', async () => {
    const course = await newCourse();
    const [s] = await students(1);
    const link = await createLink(db.pool, course, s!.id, { state: 'REVIEW_REQUIRED' });
    await L1(`/courses/${course}/links/${link}/decision`, { decision: 'REJECT', explanation: WHY });
    const res = await L1(`/courses/${course}/links/${link}/decision`, {
      decision: 'CONFIRM',
      basis: 'LECTURER_ENROLLMENT_CONFIRMED',
      explanation: 'Reconsidered after speaking to them',
    });
    expect(res.statusCode).toBe(200);
    expect((await linkRow(link)).current_review_no).toBe(3);
  });
});

describe('association decisions: history, queue, audit, access', () => {
  it('keeps the full history in order, naming lecturers and "System"', async () => {
    const course = await newCourse();
    const [s] = await students(1);
    const link = await createLink(db.pool, course, s!.id, { state: 'PROVISIONAL' });
    await L1(`/courses/${course}/links/${link}/decision`, {
      decision: 'MARK_REVIEW_REQUIRED',
      explanation: 'Name differs from the class list',
    });
    await L1(`/courses/${course}/links/${link}/decision`, {
      decision: 'REJECT',
      explanation: 'Wrong person for this entry',
    });
    await L1(`/courses/${course}/links/${link}/decision`, {
      decision: 'CONFIRM',
      basis: 'LECTURER_ENROLLMENT_CONFIRMED',
      explanation: 'Sorted out with the student',
    });

    const history = (await G1(`/courses/${course}/links/${link}/history`)).json().reviews;
    expect(
      history.map((h: { reviewNo: number; decision: string; toState: string }) => [
        h.reviewNo,
        h.decision,
        h.toState,
      ]),
    ).toEqual([
      [1, 'SYSTEM_MATCH', 'PROVISIONAL'],
      [2, 'MARK_REVIEW_REQUIRED', 'REVIEW_REQUIRED'],
      [3, 'REJECT', 'REJECTED'],
      [4, 'CONFIRM', 'CONFIRMED'],
    ]);
    expect(history[0].actor).toBe('System');
    expect(history[1].actor).toBe('Dr One');
    expect(history[3]).toMatchObject({
      basis: 'LECTURER_ENROLLMENT_CONFIRMED',
      fromState: 'REJECTED',
    });
  });

  it('lists only matches that need attention, and a decided one leaves the queue', async () => {
    const course = await newCourse();
    const [a, b, c, d] = await students(4);
    const pending = await createLink(db.pool, course, a!.id, { state: 'PROVISIONAL' });
    await createLink(db.pool, course, b!.id, { state: 'REVIEW_REQUIRED' });
    await createLink(db.pool, course, c!.id, { state: 'CONFIRMED' });
    await createLink(db.pool, course, d!.id, { state: 'REJECTED' });
    let queue = (await G1(`/courses/${course}/review-queue`)).json();
    expect(queue.links.map((l: { studentId: string }) => l.studentId).sort()).toEqual(
      [a!.studentId, b!.studentId].sort(),
    );
    expect(queue.links[0].state).toBe('REVIEW_REQUIRED'); // most urgent first

    await L1(`/courses/${course}/links/${pending}/decision`, {
      decision: 'CONFIRM',
      basis: 'LECTURER_ENROLLMENT_CONFIRMED',
      explanation: WHY,
    });
    queue = (await G1(`/courses/${course}/review-queue`)).json();
    expect(queue.links).toHaveLength(1);
  });

  it('audits each decision without free text, and rolls everything back if the audit write fails', async () => {
    const course = await newCourse();
    const [s] = await students(1);
    const link = await createLink(db.pool, course, s!.id, { state: 'REVIEW_REQUIRED' });
    await L1(`/courses/${course}/links/${link}/decision`, {
      decision: 'KEEP_PROVISIONAL',
      explanation: 'Please keep this secret note out of logs',
    });
    expect(await auditCount('LINK_DECISION', link)).toBe(1);
    const summary = (
      await db.pool.query(
        `SELECT summary FROM audit_events WHERE action = 'LINK_DECISION' AND entity_id = $1`,
        [link],
      )
    ).rows[0].summary;
    expect(summary).toEqual({
      decision: 'KEEP_PROVISIONAL',
      from: 'REVIEW_REQUIRED',
      to: 'PROVISIONAL',
      basis: null,
    });

    await db.pool.query(
      `CREATE OR REPLACE FUNCTION fail_audit_link() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'forced'; END $$`,
    );
    await db.pool.query(
      `CREATE TRIGGER fail_audit_link_trg BEFORE INSERT ON audit_events FOR EACH ROW WHEN (NEW.action = 'LINK_DECISION') EXECUTE FUNCTION fail_audit_link()`,
    );
    try {
      const before = await linkRow(link);
      const res = await L1(`/courses/${course}/links/${link}/decision`, {
        decision: 'REJECT',
        explanation: WHY,
      });
      expect(res.statusCode).toBe(500);
      expect(await linkRow(link)).toEqual(before);
      expect(
        (
          await db.pool.query(
            'SELECT count(*)::int AS n FROM identity_reviews WHERE link_id = $1',
            [link],
          )
        ).rows[0].n,
      ).toBe(before.current_review_no);
    } finally {
      await db.pool.query('DROP TRIGGER IF EXISTS fail_audit_link_trg ON audit_events');
    }
  });

  it("is reachable only by the course's lecturers, and a link from another course is not found", async () => {
    const course = await newCourse();
    const other = await newCourse();
    const [s] = await students(1);
    const link = await createLink(db.pool, course, s!.id, { state: 'REVIEW_REQUIRED' });
    const decide = (path: string, cookie: string) =>
      post(t.app, path, { decision: 'REJECT', explanation: WHY }, { cookie });
    expect(
      (await decide(`/courses/${course}/links/${link}/decision`, lecturer2.cookie)).statusCode,
    ).toBe(404);
    expect((await decide(`/courses/${course}/links/${link}/decision`, s!.cookie)).statusCode).toBe(
      403,
    );
    expect(
      (
        await post(t.app, `/courses/${course}/links/${link}/decision`, {
          decision: 'REJECT',
          explanation: WHY,
        })
      ).statusCode,
    ).toBe(401);
    expect(
      (await decide(`/courses/${other}/links/${link}/decision`, lecturer1.cookie)).statusCode,
    ).toBe(404); // right lecturer, wrong course
    expect(
      (await decide(`/courses/${course}/links/not-a-uuid/decision`, lecturer1.cookie)).statusCode,
    ).toBe(404);
    expect(
      (await get(t.app, `/courses/${course}/links/${link}/history`, { cookie: lecturer2.cookie }))
        .statusCode,
    ).toBe(404);
    expect((await linkRow(link)).state).toBe('REVIEW_REQUIRED');
  });

  it('similarity suggestions never change a match; only an explicit decision does', async () => {
    const course = await newCourse();
    const [s] = await students(1);
    await db.pool.query(`UPDATE users SET full_name = 'Ama Mensa' WHERE id = $1`, [s!.id]);
    await importRoster(course, 'student_id,full_name\nSIM-1,Ama Mensah\n');
    const link = await createLink(db.pool, course, s!.id, { state: 'REVIEW_REQUIRED' });
    const before = await linkRow(link);
    const suggestions = (await G1(`/courses/${course}/links/${link}/suggestions`)).json();
    expect(suggestions.candidates.length).toBeGreaterThan(0);
    expect(await linkRow(link)).toEqual(before);
    expect(
      (
        await db.pool.query(
          'SELECT 1 FROM roster_links WHERE roster_entry_id IS NOT NULL AND course_id = $1',
          [course],
        )
      ).rowCount,
    ).toBe(0);
  });
});

describe('investigation flags (ATT-02: independent of attendance)', () => {
  const raise = (course: string, body: object) => L1(`/courses/${course}/flags`, body);

  it('a lecturer can raise a flag on a record, a student or a session, with a note and history', async () => {
    const course = await newCourse();
    const { s, session, attendanceId } = await attended(course);
    const link = (
      await db.pool.query<{ id: string }>(
        'SELECT id FROM roster_links WHERE course_id = $1 AND student_id = $2',
        [course, s.id],
      )
    ).rows[0]!.id;

    const onRecord = await raise(course, {
      kind: 'PROXY_SUSPECTED',
      attendanceId,
      note: 'Phone was passed along the row',
    });
    expect(onRecord.statusCode).toBe(201);
    const onLink = await raise(course, {
      kind: 'AMBIGUOUS_ROSTER_MATCH',
      linkId: link,
      note: 'Two similar names on the list',
    });
    const onSession = await raise(course, {
      kind: 'PROXY_SUSPECTED',
      sessionId: session,
      note: 'Several scans from one seat',
    });
    expect([onLink.statusCode, onSession.statusCode]).toEqual([201, 201]);

    const row = (
      await db.pool.query(
        'SELECT origin::text AS origin, raised_by, state::text AS state FROM investigation_flags WHERE id = $1',
        [onRecord.json().flagId],
      )
    ).rows[0];
    expect(row).toEqual({ origin: 'LECTURER', raised_by: lecturer1.id, state: 'OPEN' });
    const history = (await G1(`/courses/${course}/flags/${onRecord.json().flagId}/history`)).json();
    expect(history.events).toEqual([
      expect.objectContaining({
        eventNo: 1,
        fromState: null,
        toState: 'OPEN',
        note: 'Phone was passed along the row',
        actor: 'Dr One',
      }),
    ]);
    expect(await auditCount('FLAG_RAISED', onRecord.json().flagId)).toBe(1);
  });

  it('needs a subject and a real note; the subject must be in this course; duplicates are refused', async () => {
    const course = await newCourse();
    const other = await newCourse();
    const { attendanceId } = await attended(course);
    const foreign = await attended(other);

    expect(
      (await raise(course, { kind: 'PROXY_SUSPECTED', note: 'No subject given here' })).json().error
        .code,
    ).toBe('SUBJECT_REQUIRED');
    expect(
      (await raise(course, { kind: 'PROXY_SUSPECTED', attendanceId, note: 'short' })).statusCode,
    ).toBe(400);
    expect(
      (await raise(course, { kind: 'MADE_UP', attendanceId, note: 'A perfectly long note' }))
        .statusCode,
    ).toBe(400);
    expect(
      (
        await raise(course, {
          kind: 'PROXY_SUSPECTED',
          attendanceId: foreign.attendanceId,
          note: 'Belongs to another course',
        })
      ).statusCode,
    ).toBe(404);

    expect(
      (await raise(course, { kind: 'PROXY_SUSPECTED', attendanceId, note: 'First concern raised' }))
        .statusCode,
    ).toBe(201);
    const dup = await raise(course, {
      kind: 'PROXY_SUSPECTED',
      attendanceId,
      note: 'The same concern again',
    });
    expect(dup.statusCode).toBe(409);
    expect(dup.json().error.code).toBe('DUPLICATE_ACTIVE_FLAG');
  });

  it('follows the lifecycle OPEN → UNDER_REVIEW → DISMISSED/SUBSTANTIATED → UNDER_REVIEW and nothing else', async () => {
    const course = await newCourse();
    const { attendanceId } = await attended(course);
    const flagId = (
      await raise(course, {
        kind: 'PROXY_SUSPECTED',
        attendanceId,
        note: 'Concern about this record',
      })
    ).json().flagId as string;
    const go = (to: string, note = 'Reviewed with the student in person') =>
      L1(`/courses/${course}/flags/${flagId}/transition`, { to, note });
    const state = async () =>
      (
        await db.pool.query('SELECT state::text AS state FROM investigation_flags WHERE id = $1', [
          flagId,
        ])
      ).rows[0].state;

    // Not allowed from OPEN: resolving directly, or going back.
    expect((await go('DISMISSED')).json().error.code).toBe('INVALID_TRANSITION');
    expect((await go('SUBSTANTIATED')).statusCode).toBe(409);
    expect(await state()).toBe('OPEN');

    expect(
      (await L1(`/courses/${course}/flags/${flagId}/transition`, { to: 'UNDER_REVIEW' }))
        .statusCode,
    ).toBe(200); // no note needed to start a review
    expect((await go('UNDER_REVIEW')).statusCode).toBe(409);
    expect((await go('DISMISSED', 'short')).statusCode).toBe(400); // resolving needs a real note
    expect((await go('DISMISSED', '')).statusCode).toBe(400);
    expect((await go('SUBSTANTIATED')).statusCode).toBe(200);
    expect(await state()).toBe('SUBSTANTIATED');
    expect((await go('DISMISSED')).statusCode).toBe(409); // must be reopened first
    expect(
      (
        await L1(`/courses/${course}/flags/${flagId}/transition`, {
          to: 'UNDER_REVIEW',
          note: 'tiny',
        })
      ).statusCode,
    ).toBe(400); // reopening needs a note too
    expect((await go('UNDER_REVIEW', 'New evidence has come to light')).statusCode).toBe(200);
    expect((await go('DISMISSED', 'On reflection this was a misunderstanding')).statusCode).toBe(
      200,
    );

    const events = (await G1(`/courses/${course}/flags/${flagId}/history`)).json().events;
    expect(
      events.map((e: { fromState: string | null; toState: string }) => [e.fromState, e.toState]),
    ).toEqual([
      [null, 'OPEN'],
      ['OPEN', 'UNDER_REVIEW'],
      ['UNDER_REVIEW', 'SUBSTANTIATED'],
      ['SUBSTANTIATED', 'UNDER_REVIEW'],
      ['UNDER_REVIEW', 'DISMISSED'],
    ]);
    expect(await auditCount('FLAG_TRANSITIONED', flagId)).toBe(4);
  });

  it('ATT-02: raising, reviewing and substantiating a flag leaves attendance and the match exactly as they were', async () => {
    const course = await newCourse();
    const { s, session, attendanceId } = await attended(course);
    const link = (
      await db.pool.query<{ id: string }>(
        'SELECT id FROM roster_links WHERE course_id = $1 AND student_id = $2',
        [course, s.id],
      )
    ).rows[0]!.id;
    const snapshot = async () => ({
      attendance: await statusOf(attendanceId),
      revisions: await revisions(attendanceId),
      link: await linkRow(link),
      reviews: (
        await db.pool.query('SELECT count(*)::int AS n FROM identity_reviews WHERE link_id = $1', [
          link,
        ])
      ).rows[0].n,
    });
    const before = await snapshot();
    const countsBefore = await countsFor(course, session);

    const flagId = (
      await raise(course, {
        kind: 'PROXY_SUSPECTED',
        attendanceId,
        note: 'Suspected proxy attendance',
      })
    ).json().flagId as string;
    expect((await countsFor(course, session)).flaggedPresent).toBe(1); // visible as an overlay...
    await L1(`/courses/${course}/flags/${flagId}/transition`, { to: 'UNDER_REVIEW' });
    await L1(`/courses/${course}/flags/${flagId}/transition`, {
      to: 'SUBSTANTIATED',
      note: 'Confirmed with the student, it was a proxy',
    });

    expect(await snapshot()).toEqual(before); // ...but nothing about the record or match changed
    const countsAfter = await countsFor(course, session);
    expect(countsAfter).toMatchObject({
      presentTotal: countsBefore.presentTotal,
      confirmed: countsBefore.confirmed,
      provisional: countsBefore.provisional,
      invalidated: 0,
      flaggedPresent: 0,
    });

    // The lecturer then makes the attendance decision as a separate, recorded act.
    const inv = await L1(att(course, session, attendanceId, '/invalidate'), {
      category: 'CONFIRMED_PROXY',
      explanation: 'Flag substantiated: student admitted proxy',
    });
    expect(inv.statusCode).toBe(200);
    expect((await revisions(attendanceId)).map((r) => r.kind)).toEqual([
      'CREATED_QR',
      'INVALIDATED',
    ]);
  });

  it('two simultaneous transitions: one applies, the other is refused', async () => {
    const course = await newCourse();
    const { attendanceId } = await attended(course);
    const flagId = (
      await raise(course, {
        kind: 'PROXY_SUSPECTED',
        attendanceId,
        note: 'Concern about this record',
      })
    ).json().flagId as string;
    const results = await Promise.all(
      [1, 2, 3].map(() =>
        L1(`/courses/${course}/flags/${flagId}/transition`, { to: 'UNDER_REVIEW' }),
      ),
    );
    expect(results.map((r) => r.statusCode).sort()).toEqual([200, 409, 409]);
    expect(
      (
        await db.pool.query(
          'SELECT count(*)::int AS n FROM investigation_flag_events WHERE flag_id = $1',
          [flagId],
        )
      ).rows[0].n,
    ).toBe(2);
  });

  it("is limited to the course's lecturers", async () => {
    const course = await newCourse();
    const { attendanceId, s } = await attended(course);
    expect(
      (
        await post(
          t.app,
          `/courses/${course}/flags`,
          { kind: 'PROXY_SUSPECTED', attendanceId, note: 'Not my course at all' },
          { cookie: lecturer2.cookie },
        )
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await post(
          t.app,
          `/courses/${course}/flags`,
          { kind: 'PROXY_SUSPECTED', attendanceId, note: 'Students cannot flag' },
          { cookie: s.cookie },
        )
      ).statusCode,
    ).toBe(403);
    const flagId = (
      await raise(course, {
        kind: 'PROXY_SUSPECTED',
        attendanceId,
        note: 'Concern about this record',
      })
    ).json().flagId as string;
    expect(
      (await get(t.app, `/courses/${course}/flags/${flagId}/history`, { cookie: lecturer2.cookie }))
        .statusCode,
    ).toBe(404);
  });
});

describe('ATT-04 invalidating and restoring attendance', () => {
  it.each([
    'INCORRECT_ENTRY',
    'CONFIRMED_PROXY',
    'DUPLICATE_OR_ERRONEOUS',
    'IDENTITY_ENROLLMENT_MISMATCH',
    'OTHER',
  ])(
    'invalidates with the "%s" reason and keeps who, when, why and the previous state',
    async (category) => {
      const course = await newCourse();
      const { s, session, attendanceId } = await attended(course);
      const res = await L1(att(course, session, attendanceId, '/invalidate'), {
        category,
        explanation: '  Written explanation for the record  ',
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ status: 'INVALIDATED', revNo: 2 });

      expect(await statusOf(attendanceId)).toEqual({ status: 'INVALIDATED', current_rev_no: 2 });
      expect((await revisions(attendanceId))[1]).toMatchObject({
        rev_no: 2,
        kind: 'INVALIDATED',
        from_status: 'PRESENT',
        to_status: 'INVALIDATED',
        category,
        explanation: 'Written explanation for the record',
        actor_user_id: lecturer1.id,
      });
      expect(await countsFor(course, session)).toMatchObject({ presentTotal: 0, invalidated: 1 });

      // The student sees the category, never the explanation.
      const mine = await get(t.app, '/me/attendance', { cookie: s.cookie });
      expect(mine.json().courses[0].sessions[0]).toMatchObject({
        status: 'INVALIDATED',
        invalidationCategory: category,
      });
      expect(mine.body).not.toContain('Written explanation');
    },
  );

  it('requires both a valid category and a written explanation, and changes nothing otherwise', async () => {
    const course = await newCourse();
    const { session, attendanceId } = await attended(course);
    const url = att(course, session, attendanceId, '/invalidate');
    for (const body of [
      {},
      { category: 'OTHER' },
      { explanation: WHY },
      { category: 'NOT_A_REASON', explanation: WHY },
      { category: 'OTHER', explanation: '' },
      { category: 'OTHER', explanation: '          ' },
      { category: 'OTHER', explanation: 'too short' },
    ]) {
      expect((await L1(url, body)).statusCode, JSON.stringify(body)).toBe(400);
    }
    expect(await statusOf(attendanceId)).toEqual({ status: 'PRESENT', current_rev_no: 1 });
    expect(await revisions(attendanceId)).toHaveLength(1);
  });

  it('restores with an explanation, keeping every earlier revision', async () => {
    const course = await newCourse();
    const { session, attendanceId } = await attended(course);
    const url = (tail: string) => att(course, session, attendanceId, tail);
    await L1(url('/invalidate'), {
      category: 'INCORRECT_ENTRY',
      explanation: 'Marked against the wrong student',
    });
    expect((await L1(url('/restore'), {})).statusCode).toBe(400);
    expect((await L1(url('/restore'), { explanation: 'tiny' })).statusCode).toBe(400);
    expect(
      (await L1(url('/restore'), { explanation: 'Checked again: they were present' })).statusCode,
    ).toBe(200);
    await L1(url('/invalidate'), {
      category: 'OTHER',
      explanation: 'Withdrawn after a second review',
    });

    const history = (await G1(url('/history'))).json();
    expect(
      history.revisions.map(
        (r: { revNo: number; kind: string; fromStatus: string | null; toStatus: string }) => [
          r.revNo,
          r.kind,
          r.fromStatus,
          r.toStatus,
        ],
      ),
    ).toEqual([
      [1, 'CREATED_QR', null, 'PRESENT'],
      [2, 'INVALIDATED', 'PRESENT', 'INVALIDATED'],
      [3, 'RESTORED', 'INVALIDATED', 'PRESENT'],
      [4, 'INVALIDATED', 'PRESENT', 'INVALIDATED'],
    ]);
    expect(history.revisions[2]).toMatchObject({
      explanation: 'Checked again: they were present',
      actor: 'Dr One',
      category: null,
    });
    expect(history.record.status).toBe('INVALIDATED');
    expect(await auditCount('ATTENDANCE_INVALIDATED', attendanceId)).toBe(2);
    expect(await auditCount('ATTENDANCE_RESTORED', attendanceId)).toBe(1);
  });

  it('refuses impossible changes: invalidating twice, restoring a present record', async () => {
    const course = await newCourse();
    const { session, attendanceId } = await attended(course);
    const url = (tail: string) => att(course, session, attendanceId, tail);
    expect(
      (await L1(url('/restore'), { explanation: 'It is already present' })).json().error.code,
    ).toBe('INVALID_TRANSITION');
    await L1(url('/invalidate'), { category: 'OTHER', explanation: 'First invalidation reason' });
    expect(
      (
        await L1(url('/invalidate'), {
          category: 'OTHER',
          explanation: 'Second invalidation reason',
        })
      ).statusCode,
    ).toBe(409);
    expect(await revisions(attendanceId)).toHaveLength(2);
  });

  it('five simultaneous invalidations produce exactly one change', async () => {
    const course = await newCourse();
    const { session, attendanceId } = await attended(course);
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        L1(att(course, session, attendanceId, '/invalidate'), {
          category: 'OTHER',
          explanation: 'Raced invalidation request',
        }),
      ),
    );
    expect(results.filter((r) => r.statusCode === 200)).toHaveLength(1);
    expect(results.filter((r) => r.statusCode === 409)).toHaveLength(4);
    expect(await revisions(attendanceId)).toHaveLength(2);
  });

  it("works after the session has ended, and cannot reach another session's, course's or lecturer's records", async () => {
    const course = await newCourse();
    const other = await newCourse();
    const { session, attendanceId } = await attended(course);
    await L1(`/courses/${course}/sessions/${session}/end`);
    expect(
      (
        await L1(att(course, session, attendanceId, '/invalidate'), {
          category: 'OTHER',
          explanation: 'Correction after the class ended',
        })
      ).statusCode,
    ).toBe(200);

    const otherSession = await openSession(course);
    expect(
      (
        await L1(att(course, otherSession, attendanceId, '/invalidate'), {
          category: 'OTHER',
          explanation: WHY,
        })
      ).statusCode,
    ).toBe(404); // wrong session
    expect(
      (await L1(att(other, session, attendanceId, '/restore'), { explanation: WHY })).statusCode,
    ).toBe(404); // wrong course
    expect(
      (
        await post(
          t.app,
          att(course, session, attendanceId, '/restore'),
          { explanation: WHY },
          { cookie: lecturer2.cookie },
        )
      ).statusCode,
    ).toBe(404);
    expect(
      (await L1(att(course, session, 'not-a-uuid', '/restore'), { explanation: WHY })).statusCode,
    ).toBe(404);
    expect((await statusOf(attendanceId)).status).toBe('INVALIDATED');
  });

  it('writes the audit event atomically with the change', async () => {
    const course = await newCourse();
    const { session, attendanceId } = await attended(course);
    await db.pool.query(
      `CREATE OR REPLACE FUNCTION fail_audit_att() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'forced'; END $$`,
    );
    await db.pool.query(
      `CREATE TRIGGER fail_audit_att_trg BEFORE INSERT ON audit_events FOR EACH ROW WHEN (NEW.action = 'ATTENDANCE_INVALIDATED') EXECUTE FUNCTION fail_audit_att()`,
    );
    try {
      const res = await L1(att(course, session, attendanceId, '/invalidate'), {
        category: 'OTHER',
        explanation: 'This will fail in audit',
      });
      expect(res.statusCode).toBe(500);
      expect(await statusOf(attendanceId)).toEqual({ status: 'PRESENT', current_rev_no: 1 });
      expect(await revisions(attendanceId)).toHaveLength(1);
    } finally {
      await db.pool.query('DROP TRIGGER IF EXISTS fail_audit_att_trg ON audit_events');
    }
    const ok = await L1(att(course, session, attendanceId, '/invalidate'), {
      category: 'OTHER',
      explanation: 'Now it works properly',
    });
    expect(ok.statusCode).toBe(200);
    const summary = (
      await db.pool.query(
        `SELECT summary FROM audit_events WHERE action = 'ATTENDANCE_INVALIDATED' AND entity_id = $1`,
        [attendanceId],
      )
    ).rows[0].summary;
    expect(summary).toEqual({ from: 'PRESENT', to: 'INVALIDATED', category: 'OTHER' }); // category, never the explanation
  });
});

describe('ATT-05 marking a student present without a QR scan', () => {
  const manual = (course: string, session: string, body: object, cookie = lecturer1.cookie) =>
    post(t.app, `/courses/${course}/sessions/${session}/attendance/manual`, body, { cookie });

  it('records a clearly manual attendance, with the lecturer and the reason, as a provisional match', async () => {
    const course = await newCourse();
    const session = await openSession(course);
    const [s] = await students(1);
    const res = await manual(course, session, {
      studentId: `  ${s!.studentId.toLowerCase().slice(0, 4)} ${s!.studentId.slice(4).toLowerCase()} `,
      explanation: 'Camera broken, saw them in class',
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({
      status: 'PRESENT',
      associationState: 'PROVISIONAL',
      student: { studentId: s!.studentId },
    });

    const rec = (
      await db.pool.query(
        `SELECT source::text AS source, manual_marked_by, status::text AS status FROM attendance_records WHERE session_id = $1 AND student_id = $2`,
        [session, s!.id],
      )
    ).rows[0];
    expect(rec).toEqual({ source: 'MANUAL', manual_marked_by: lecturer1.id, status: 'PRESENT' });
    const rev = (await revisions(res.json().attendanceId))[0];
    expect(rev).toMatchObject({
      kind: 'CREATED_MANUAL',
      from_status: null,
      to_status: 'PRESENT',
      actor_user_id: lecturer1.id,
      explanation: 'Camera broken, saw them in class',
    });

    const roster = (await G1(`/courses/${course}/sessions/${session}/attendance`)).json();
    expect(roster.records[0]).toMatchObject({ source: 'MANUAL', status: 'PRESENT' }); // distinguishable
    expect(roster.counts).toMatchObject({ presentTotal: 1, provisional: 1, confirmed: 0 }); // marking present does not confirm identity
    expect(
      (await get(t.app, '/me/attendance', { cookie: s!.cookie })).json().courses[0].sessions[0]
        .status,
    ).toBe('PRESENT');
    expect(await auditCount('ATTENDANCE_MARKED_MANUALLY', res.json().attendanceId)).toBe(1);
  });

  it('needs a written reason, a known student, and a session that has started', async () => {
    const course = await newCourse();
    const session = await openSession(course);
    const notStarted = (await L1(`/courses/${course}/sessions`, { title: 'Later' })).json().session
      .id as string;
    const [s] = await students(1);
    for (const body of [
      {},
      { studentId: s!.studentId },
      { studentId: s!.studentId, explanation: 'short' },
      { explanation: WHY },
      { studentId: '', explanation: WHY },
    ]) {
      expect((await manual(course, session, body)).statusCode, JSON.stringify(body)).toBe(400);
    }
    const unknown = await manual(course, session, {
      studentId: 'NOT-REGISTERED-9',
      explanation: WHY,
    });
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json().error.code).toBe('STUDENT_NOT_REGISTERED');
    expect(
      (await manual(course, notStarted, { studentId: s!.studentId, explanation: WHY })).json().error
        .code,
    ).toBe('SESSION_NOT_STARTED');
    await db.pool.query(`UPDATE users SET status = 'DISABLED' WHERE id = $1`, [s!.id]);
    expect(
      (await manual(course, session, { studentId: s!.studentId, explanation: WHY })).statusCode,
    ).toBe(404);
    expect(
      (await db.pool.query('SELECT 1 FROM attendance_records WHERE session_id = $1', [session]))
        .rowCount,
    ).toBe(0);
  });

  it('refuses a second record for the same student and session, whoever made the first', async () => {
    const course = await newCourse();
    const session = await openSession(course);
    const [byScan, byHand] = await students(2);
    await scan(byScan!, session);
    const dupScan = await manual(course, session, {
      studentId: byScan!.studentId,
      explanation: WHY,
    });
    expect(dupScan.statusCode).toBe(409);
    expect(dupScan.json().error).toMatchObject({ code: 'ALREADY_RECORDED', status: 'PRESENT' });

    expect(
      (await manual(course, session, { studentId: byHand!.studentId, explanation: WHY }))
        .statusCode,
    ).toBe(201);
    expect(
      (await manual(course, session, { studentId: byHand!.studentId, explanation: WHY }))
        .statusCode,
    ).toBe(409);
    expect(
      (
        await db.pool.query(
          'SELECT count(*)::int AS n FROM attendance_records WHERE session_id = $1',
          [session],
        )
      ).rows[0].n,
    ).toBe(2);
  });

  it('works after the class has ended, and a manual record can later be invalidated like any other', async () => {
    const course = await newCourse();
    const session = await openSession(course);
    await L1(`/courses/${course}/sessions/${session}/end`);
    const [s] = await students(1);
    const res = await manual(course, session, {
      studentId: s!.studentId,
      explanation: 'Late paper sign-in sheet',
    });
    expect(res.statusCode).toBe(201);
    expect(
      (
        await L1(att(course, session, res.json().attendanceId, '/invalidate'), {
          category: 'INCORRECT_ENTRY',
          explanation: 'Entered for the wrong student',
        })
      ).statusCode,
    ).toBe(200);
    expect((await revisions(res.json().attendanceId)).map((r) => r.kind)).toEqual([
      'CREATED_MANUAL',
      'INVALIDATED',
    ]);
  });

  it("a manual mark racing the student's own scan yields exactly one record", async () => {
    const course = await newCourse();
    const session = await openSession(course);
    const [s] = await students(1);
    const [a, b] = await Promise.all([
      scan(s!, session),
      manual(course, session, {
        studentId: s!.studentId,
        explanation: 'Marked while they were scanning',
      }),
    ]);
    expect([201, 200]).toContain(a.statusCode);
    expect([201, 409]).toContain(b.statusCode);
    expect(
      (
        await db.pool.query(
          'SELECT count(*)::int AS n FROM attendance_records WHERE session_id = $1',
          [session],
        )
      ).rows[0].n,
    ).toBe(1);
    expect(
      (
        await db.pool.query(
          'SELECT count(*)::int AS n FROM attendance_revisions r JOIN attendance_records a ON a.id = r.attendance_id WHERE a.session_id = $1',
          [session],
        )
      ).rows[0].n,
    ).toBe(1);
  });

  it("is limited to the course's lecturers", async () => {
    const course = await newCourse();
    const session = await openSession(course);
    const [s] = await students(1);
    expect(
      (
        await manual(
          course,
          session,
          { studentId: s!.studentId, explanation: WHY },
          lecturer2.cookie,
        )
      ).statusCode,
    ).toBe(404);
    expect(
      (await manual(course, session, { studentId: s!.studentId, explanation: WHY }, s!.cookie))
        .statusCode,
    ).toBe(403);
    expect(
      (
        await post(t.app, `/courses/${course}/sessions/${session}/attendance/manual`, {
          studentId: s!.studentId,
          explanation: WHY,
        })
      ).statusCode,
    ).toBe(401);
    expect(
      (await db.pool.query('SELECT 1 FROM attendance_records WHERE session_id = $1', [session]))
        .rowCount,
    ).toBe(0);
  });
});

describe('history is append-only for the application', () => {
  it('the application role cannot rewrite or delete reviews, revisions or flag events', async () => {
    const course = await newCourse();
    const { attendanceId } = await attended(course);
    await L1(`/courses/${course}/flags`, {
      kind: 'PROXY_SUSPECTED',
      attendanceId,
      note: 'Concern about this record',
    });
    for (const sql of [
      `UPDATE attendance_revisions SET explanation = 'edited'`,
      `DELETE FROM attendance_revisions`,
      `UPDATE identity_reviews SET explanation = 'edited'`,
      `DELETE FROM identity_reviews`,
      `UPDATE investigation_flag_events SET note = 'edited'`,
      `DELETE FROM investigation_flag_events`,
    ]) {
      await expect(db.appPool.query(sql), sql).rejects.toMatchObject({ code: '42501' });
    }
  });

  it('keeps unused session fixture helper honest', async () => {
    const course = await newCourse();
    const id = await createSession(db.pool, course, lecturer1.id, 'CHECK_IN_OPEN');
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
  });
});

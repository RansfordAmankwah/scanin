import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createBulkStudents, type BulkStudent } from '../helpers/students.js';
import { base, createHarness, type Harness } from './harness.js';

let h: Harness;
beforeAll(async () => {
  h = await createHarness();
});
afterAll(async () => {
  await h?.close();
});

interface Case {
  s: string;
  student: BulkStudent;
  attendanceId: string;
  itemId: string;
  disputeId: string;
  recordedAt: Date;
}

/** A student checks in, is sampled, and the checker could not find them: a dispute is open. */
async function openDispute(): Promise<Case> {
  const s = await h.openSession();
  const [student] = await h.checkInStudents(s, 1);
  const listing = (await h.post(`${base(h.courseId, s)}/spot-checks`, { size: 1 })).json();
  const item = listing.rounds[0].items[0];
  const res = await h.post(`${base(h.courseId, s)}/spot-checks/items/${item.id}/result`, {
    requestId: randomUUID(),
    outcome: 'NOT_PRESENT',
    explanation: 'Called the name twice, nobody answered.',
  });
  const disputeId = res.json().rounds[0].items[0].disputeId as string;
  const recordedAt = (
    await h.db.pool.query('SELECT recorded_at FROM attendance_records WHERE id = $1', [
      item.attendanceId,
    ])
  ).rows[0]!.recorded_at as Date;
  return {
    s,
    student: student!,
    attendanceId: item.attendanceId,
    itemId: item.id,
    disputeId,
    recordedAt,
  };
}

const resolve = (c: Case, body: object, cookie?: string) =>
  h.post(`${base(h.courseId, c.s)}/disputes/${c.disputeId}/resolve`, body, cookie);
const reply = (cookie: string, disputeId: string, note: unknown) =>
  h.post(`/me/disputes/${disputeId}/response`, { note }, cookie);
const myReview = async (c: Case) => {
  const mine = (await h.get('/me/attendance', c.student.cookie)).json();
  return mine.courses
    .flatMap(
      (co: {
        sessions: Array<{
          id: string;
          review: unknown;
          status: string;
          invalidationCategory: string | null;
        }>;
      }) => co.sessions,
    )
    .find((x: { id: string }) => x.id === c.s);
};
const attendance = async (id: string) =>
  (
    await h.db.pool.query(
      'SELECT status::text AS status, current_rev_no FROM attendance_records WHERE id = $1',
      [id],
    )
  ).rows[0]!;

describe('what the student sees and can do', () => {
  it('sees only that their record is under review, can reply, and cannot see the spot check, flags or anyone else', async () => {
    const c = await openDispute();
    const row = await myReview(c);
    expect(row.status).toBe('PRESENT'); // their attendance still stands while it is reviewed
    expect(row.review).toMatchObject({ state: 'OPEN', repliesLeft: 5 });
    const raw = JSON.stringify((await h.get('/me/attendance', c.student.cookie)).json());
    for (const hidden of [
      'spot',
      'NOT_PRESENT',
      'flag',
      'risk',
      'weight',
      'explanation',
      'sourceItem',
      'Called the name',
    ]) {
      expect(raw.toLowerCase()).not.toContain(hidden.toLowerCase());
    }

    const sent = await reply(
      c.student.cookie,
      c.disputeId,
      'I was in the lab next door, my lecturer can confirm.',
    );
    expect(sent.statusCode).toBe(201);
    expect((await myReview(c)).review.repliesLeft).toBe(4);

    // The lecturer sees the reply, labelled as the student's.
    const seen = (await h.get(`${base(h.courseId, c.s)}/disputes`)).json().disputes[0];
    expect(seen).toMatchObject({ state: 'OPEN', fromSpotCheck: true, attendanceStatus: 'PRESENT' });
    const last = seen.events.at(-1);
    expect(last).toMatchObject({
      kind: 'STUDENT_RESPONSE',
      byRole: 'STUDENT',
      note: 'I was in the lab next door, my lecturer can confirm.',
    });
    expect((await h.audit('DISPUTE_STUDENT_RESPONDED', c.s))[0]!.actor_type).toBe('STUDENT');
  });

  it('limits and validates replies', async () => {
    const c = await openDispute();
    for (const bad of [undefined, '', '   ', 'x'.repeat(1001), 42]) {
      expect((await reply(c.student.cookie, c.disputeId, bad)).statusCode, String(bad)).toBe(400);
    }
    for (let i = 0; i < 5; i++)
      expect((await reply(c.student.cookie, c.disputeId, `Reply ${i + 1}`)).statusCode).toBe(201);
    const sixth = await reply(c.student.cookie, c.disputeId, 'One more');
    expect(sixth.statusCode).toBe(409);
    expect(sixth.json().error.code).toBe('TOO_MANY_RESPONSES');
  });

  it('cannot reach another student’s dispute, and cannot use the lecturer’s controls', async () => {
    const c = await openDispute();
    const [stranger] = await createBulkStudents(h.db, 1);
    const attempt = await reply(stranger!.cookie, c.disputeId, 'This is not my record');
    expect(attempt.statusCode).toBe(404); // indistinguishable from "no such dispute"
    expect((await reply(stranger!.cookie, randomUUID(), 'x')).statusCode).toBe(404);
    expect(
      await h.count(
        `SELECT 1 FROM attendance_dispute_events WHERE dispute_id = $1 AND kind = 'STUDENT_RESPONSE'`,
        [c.disputeId],
      ),
    ).toBe(0);

    for (const cookie of [c.student.cookie, stranger!.cookie]) {
      expect(
        (
          await resolve(
            c,
            { resolution: 'UPHOLD', explanation: 'I would like this to be fine' },
            cookie,
          )
        ).statusCode,
      ).toBe(403);
      expect((await h.get(`${base(h.courseId, c.s)}/disputes`, cookie)).statusCode).toBe(403);
    }
    // A lecturer, but of another course.
    expect(
      (
        await resolve(
          c,
          { resolution: 'UPHOLD', explanation: 'Not my course at all' },
          h.other.cookie,
        )
      ).statusCode,
    ).toBe(404);
    expect((await h.get(`${base(h.courseId, c.s)}/disputes`, h.other.cookie)).statusCode).toBe(404);
  });

  it('is closed to further replies once resolved', async () => {
    const c = await openDispute();
    await resolve(c, { resolution: 'UPHOLD', explanation: 'Confirmed they were present.' });
    const late = await reply(c.student.cookie, c.disputeId, 'Thank you');
    expect(late.statusCode).toBe(409);
  });
});

describe('how a lecturer resolves it', () => {
  it('can uphold the record: it stays present and the dispute closes with the reason on file', async () => {
    const c = await openDispute();
    const short = await resolve(c, { resolution: 'UPHOLD', explanation: 'fine' });
    expect(short.statusCode).toBe(400);
    const ok = await resolve(c, {
      resolution: 'UPHOLD',
      explanation: 'Another lecturer confirmed they were present.',
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ state: 'RESOLVED_UPHELD', attendanceChanged: false });
    expect(await attendance(c.attendanceId)).toMatchObject({
      status: 'PRESENT',
      current_rev_no: 1,
    });
    expect((await myReview(c)).review).toMatchObject({ state: 'RESOLVED_UPHELD' });

    const again = await resolve(c, {
      resolution: 'INVALIDATE',
      category: 'OTHER',
      explanation: 'Changed my mind again.',
    });
    expect(again.statusCode).toBe(409);
    expect(again.json().error.code).toBe('INVALID_TRANSITION');
    expect((await h.audit('DISPUTE_RESOLVED', c.s))[0]!.summary).toMatchObject({
      resolution: 'UPHELD',
      attendanceChanged: false,
    });
  });

  it('can invalidate the record, through the normal audited correction, and nothing is erased', async () => {
    const c = await openDispute();
    expect(
      (
        await resolve(c, { resolution: 'INVALIDATE', explanation: 'Checked, they were not there.' })
      ).json().error.code,
    ).toBe('CATEGORY_REQUIRED');
    const ok = await resolve(c, {
      resolution: 'INVALIDATE',
      category: 'CONFIRMED_PROXY',
      explanation: 'A friend admitted scanning for them.',
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ state: 'RESOLVED_INVALIDATED', attendanceChanged: true });

    expect(await attendance(c.attendanceId)).toMatchObject({
      status: 'INVALIDATED',
      current_rev_no: 2,
    });
    const revisions = (
      await h.db.pool.query(
        'SELECT rev_no, change_kind::text AS kind, reason_category::text AS category, explanation, actor_user_id FROM attendance_revisions WHERE attendance_id = $1 ORDER BY rev_no',
        [c.attendanceId],
      )
    ).rows;
    expect(revisions.map((r) => r.kind)).toEqual(['CREATED_QR', 'INVALIDATED']); // the original is still there
    expect(revisions[1]).toMatchObject({
      category: 'CONFIRMED_PROXY',
      explanation: 'A friend admitted scanning for them.',
      actor_user_id: h.lecturer.id,
    });
    const at = (
      await h.db.pool.query('SELECT recorded_at FROM attendance_records WHERE id = $1', [
        c.attendanceId,
      ])
    ).rows[0]!.recorded_at as Date;
    expect(at.getTime()).toBe(c.recordedAt.getTime()); // the original check-in time survives

    expect(await h.audit('ATTENDANCE_INVALIDATED', c.s)).toHaveLength(1);
    expect(await h.audit('DISPUTE_RESOLVED', c.s)).toHaveLength(1);
    // What the student is told: the category the app already shows for any invalidation, no more.
    expect(await myReview(c)).toMatchObject({
      status: 'INVALIDATED',
      invalidationCategory: 'CONFIRMED_PROXY',
      review: { state: 'RESOLVED_INVALIDATED' },
    });
    // The lecturer's roster reflects both the spot check and the dispute.
    const rec = (await h.get(`${base(h.courseId, c.s)}/attendance`)).json().records[0];
    expect(rec).toMatchObject({
      verification: 'NOT_PRESENT',
      disputeState: 'RESOLVED_INVALIDATED',
      status: 'INVALIDATED',
    });
  });

  it('closes cleanly when the record was already invalidated some other way', async () => {
    const c = await openDispute();
    await h.post(`${base(h.courseId, c.s)}/attendance/${c.attendanceId}/invalidate`, {
      category: 'INCORRECT_ENTRY',
      explanation: 'Entered under the wrong account.',
    });
    const ok = await resolve(c, {
      resolution: 'INVALIDATE',
      category: 'OTHER',
      explanation: 'Already invalidated; closing the review.',
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().attendanceChanged).toBe(false);
    expect((await attendance(c.attendanceId)).current_rev_no).toBe(2); // no second invalidation
  });

  it('leaves nothing half-done if the database fails part-way through', async () => {
    const c = await openDispute();
    // Make closing the dispute fail AFTER the record has been invalidated inside the same transaction.
    await h.db.pool.query(`
      CREATE FUNCTION fail_on_invalidating_close() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.kind = 'RESOLVED_INVALIDATED' THEN RAISE EXCEPTION 'simulated database failure'; END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER fail_close BEFORE INSERT ON attendance_dispute_events
        FOR EACH ROW EXECUTE FUNCTION fail_on_invalidating_close();`);
    try {
      const res = await resolve(c, {
        resolution: 'INVALIDATE',
        category: 'CONFIRMED_PROXY',
        explanation: 'Checked, they were not there.',
      });
      expect(res.statusCode).toBe(500);
      expect(res.body).not.toContain('attendance_dispute_events'); // no internals in the error
      expect(res.body).not.toContain('simulated');
      expect(await attendance(c.attendanceId)).toMatchObject({
        status: 'PRESENT',
        current_rev_no: 1,
      });
      expect(
        (
          await h.db.pool.query(
            'SELECT state::text AS state FROM attendance_disputes WHERE id = $1',
            [c.disputeId],
          )
        ).rows[0]!.state,
      ).toBe('OPEN');
      expect(await h.audit('ATTENDANCE_INVALIDATED', c.s)).toHaveLength(0);
      expect(await h.audit('DISPUTE_RESOLVED', c.s)).toHaveLength(0);
    } finally {
      await h.db.pool.query(
        'DROP TRIGGER fail_close ON attendance_dispute_events; DROP FUNCTION fail_on_invalidating_close();',
      );
    }
    // Once the fault is gone the same request simply works.
    const retry = await resolve(c, {
      resolution: 'INVALIDATE',
      category: 'CONFIRMED_PROXY',
      explanation: 'Checked, they were not there.',
    });
    expect(retry.statusCode).toBe(200);
    expect(await attendance(c.attendanceId)).toMatchObject({
      status: 'INVALIDATED',
      current_rev_no: 2,
    });
  });

  it('refuses a dispute id from another session in the path', async () => {
    const c = await openDispute();
    const elsewhere = await h.openSession();
    const res = await h.post(`${base(h.courseId, elsewhere)}/disputes/${c.disputeId}/resolve`, {
      resolution: 'UPHOLD',
      explanation: 'Wrong session on purpose.',
    });
    expect(res.statusCode).toBe(404);
    expect(
      (
        await h.db.pool.query(
          'SELECT state::text AS state FROM attendance_disputes WHERE id = $1',
          [c.disputeId],
        )
      ).rows[0]!.state,
    ).toBe('OPEN');
  });
});

describe('only one dispute at a time per record', () => {
  it('does not open a second dispute when the same record is found absent again', async () => {
    const c = await openDispute();
    // Correct to verified, then to not present again: the first dispute was upheld, so a new one may open.
    await h.post(`${base(h.courseId, c.s)}/spot-checks/items/${c.itemId}/result`, {
      requestId: randomUUID(),
      outcome: 'VERIFIED',
      method: 'OTHER_OFFICIAL_ID',
      explanation: 'Found them, photo ID checked.',
    });
    await h.post(`${base(h.courseId, c.s)}/spot-checks/items/${c.itemId}/result`, {
      requestId: randomUUID(),
      outcome: 'NOT_PRESENT',
      explanation: 'Looked again and they have left.',
    });
    const states = (
      await h.db.pool.query(
        'SELECT state::text AS state FROM attendance_disputes WHERE attendance_id = $1 ORDER BY opened_at',
        [c.attendanceId],
      )
    ).rows.map((r) => r.state);
    expect(states).toEqual(['RESOLVED_UPHELD', 'OPEN']);
    expect(states.filter((s) => s === 'OPEN')).toHaveLength(1);
  });
});

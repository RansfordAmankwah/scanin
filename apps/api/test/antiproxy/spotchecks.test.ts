import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  drawSample,
  generateSpotCheck,
  weightFor,
  type Candidate,
} from '../../src/antiproxy/spotChecks.js';
import { post } from '../helpers/app.js';
import { createBulkStudents } from '../helpers/students.js';
import { base, createHarness, type Harness } from './harness.js';

let h: Harness;
beforeAll(async () => {
  h = await createHarness();
});
afterAll(async () => {
  await h?.close();
});

interface Item {
  id: string;
  attendanceId: string;
  studentId: string;
  selectionReason: string;
  riskFactors: string[];
  state: string;
  disputeId: string | null;
  disputeState: string | null;
  history: Array<{ from: string; to: string; method: string | null; explanation: string | null }>;
}
interface Listing {
  rounds: Array<{
    id: string;
    requestedSize: number;
    eligibleCount: number;
    selectedCount: number;
    items: Item[];
  }>;
  summary: { pending: number; verified: number; notPresent: number; couldNotVerify: number };
  limits: { defaultSize: number; maxSize: number };
}

const gen = (hh: Harness, s: string, body: object = {}) =>
  hh.post(`${base(hh.courseId, s)}/spot-checks`, body);
const list = async (hh: Harness, s: string) =>
  (await hh.get(`${base(hh.courseId, s)}/spot-checks`)).json() as Listing;
const allItems = (l: Listing) => l.rounds.flatMap((r) => r.items);
const result = (hh: Harness, s: string, itemId: string, body: object, requestId = randomUUID()) =>
  hh.post(`${base(hh.courseId, s)}/spot-checks/items/${itemId}/result`, { requestId, ...body });
const verifiedBody = { outcome: 'VERIFIED', method: 'STUDENT_ID_CARD' };
const missingBody = {
  outcome: 'NOT_PRESENT',
  explanation: 'Called the name twice, nobody answered.',
};

/** A small, repeatable random source (a linear congruential generator). Tests only. */
function seeded(seed: number): () => number {
  let x = seed >>> 0;
  return () => {
    x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
    return (x + 0.5) / 2 ** 32;
  };
}

describe('how a sample is drawn (the algorithm itself)', () => {
  const people = (weights: number[]): Candidate[] =>
    weights.map((weight, i) => ({
      attendanceId: `a${i}`,
      studentId: `s${i}`,
      factors: [],
      recentlySampled: false,
      weight,
    }));

  it('is uniform when everyone has the same chance', () => {
    const rng = seeded(7);
    const wins = [0, 0, 0, 0];
    for (let i = 0; i < 8000; i++)
      wins[Number(drawSample(people([1, 1, 1, 1]), 1, rng)[0]!.studentId.slice(1))]! += 1;
    for (const w of wins) {
      expect(w / 8000).toBeGreaterThan(0.22);
      expect(w / 8000).toBeLessThan(0.28);
    }
  });

  it('raises the chance in proportion to the weight, without making anyone certain', () => {
    const rng = seeded(11);
    let first = 0;
    for (let i = 0; i < 8000; i++)
      if (drawSample(people([4, 1, 1, 1]), 1, rng)[0]!.studentId === 's0') first += 1;
    expect(first / 8000).toBeGreaterThan(0.53); // 4 / 7 is about 0.571
    expect(first / 8000).toBeLessThan(0.62);
    expect(first).toBeLessThan(8000);
  });

  it('never repeats a student and never returns more than exist', () => {
    const picked = drawSample(people([1, 1, 1]), 10, seeded(3));
    expect(picked).toHaveLength(3);
    expect(new Set(picked.map((p) => p.studentId)).size).toBe(3);
  });

  it('boosts for evidence up to a cap, and lowers for recent selection without excluding', () => {
    expect(weightFor([], false)).toBe(1);
    expect(weightFor(['DEVICE_SHARED_FLAG'], false)).toBe(2);
    expect(weightFor(['DEVICE_SHARED_FLAG', 'PRIOR_NOT_PRESENT_RESULT'], false)).toBe(4);
    expect(weightFor([], true)).toBeCloseTo(0.3);
    expect(weightFor([], true)).toBeGreaterThan(0);
  });
});

describe('who can be selected and how many', () => {
  it('uses the configured default and never exceeds the configured maximum', async () => {
    const s = await h.openSession();
    await h.checkInStudents(s, 30);
    const first = await gen(h, s);
    expect(first.statusCode).toBe(201);
    const l = first.json() as Listing;
    expect(l.limits).toEqual({ defaultSize: 5, maxSize: 20 });
    expect(l.rounds[0]).toMatchObject({ requestedSize: 5, selectedCount: 5, eligibleCount: 30 });
    for (const bad of [0, -3, 21, 2.5, 'ten']) {
      const res = await gen(h, s, { size: bad });
      expect(res.statusCode, String(bad)).toBe(400);
      expect(res.json().error.code).toBe('INVALID_SAMPLE_SIZE');
    }
    expect((await gen(h, s, { size: 20 })).statusCode).toBe(201);
    expect(await h.count('SELECT 1 FROM spot_check_items WHERE session_id = $1', [s])).toBe(25);
  });

  it('selects only students recorded present by QR scan: not invalidated, not marked by hand, not from another session', async () => {
    const s = await h.openSession();
    const other = await h.openSession();
    const here = await h.checkInStudents(s, 8);
    await h.checkInStudents(other, 5);

    const roster = (await h.get(`${base(h.courseId, s)}/attendance`)).json().records as Array<{
      attendanceId: string;
    }>;
    const invalidated = new Set<string>();
    for (const rec of roster.slice(0, 2)) {
      await h.post(`${base(h.courseId, s)}/attendance/${rec.attendanceId}/invalidate`, {
        category: 'INCORRECT_ENTRY',
        explanation: 'Entered by mistake, confirmed in person.',
      });
      invalidated.add(rec.attendanceId);
    }
    const [manual] = await createBulkStudents(h.db, 1);
    const marked = await h.post(`${base(h.courseId, s)}/attendance/manual`, {
      studentId: manual!.studentId,
      explanation: 'Phone battery died, lecturer saw them arrive.',
    });
    expect(marked.statusCode).toBe(201);

    const attendanceBefore = await h.count(
      'SELECT 1 FROM attendance_records WHERE session_id = $1',
      [s],
    );
    const res = await gen(h, s, { size: 20 });
    const picked = allItems(res.json() as Listing);
    expect(picked).toHaveLength(6); // 8 scanned, minus 2 invalidated; the manual one is the lecturer's own word
    for (const item of picked) {
      expect(invalidated.has(item.attendanceId)).toBe(false);
      const row = await h.db.pool.query(
        'SELECT session_id, status::text AS status, source::text AS source FROM attendance_records WHERE id = $1',
        [item.attendanceId],
      );
      expect(row.rows[0]).toMatchObject({ session_id: s, status: 'PRESENT', source: 'QR_SCAN' });
    }
    expect(here.length).toBe(8);
    // Selecting never creates, changes or duplicates attendance.
    expect(await h.count('SELECT 1 FROM attendance_records WHERE session_id = $1', [s])).toBe(
      attendanceBefore,
    );
  });

  it('draws later rounds from students not yet sampled, and says so when no one is left', async () => {
    const s = await h.openSession();
    await h.checkInStudents(s, 6);
    expect(allItems((await gen(h, s, { size: 4 })).json())).toHaveLength(4);
    const second = (await gen(h, s, { size: 4 })).json() as Listing;
    expect(second.rounds[1]).toMatchObject({
      requestedSize: 4,
      selectedCount: 2,
      eligibleCount: 2,
    });
    const ids = allItems(second).map((i) => i.attendanceId);
    expect(new Set(ids).size).toBe(6); // each student at most once
    const none = await gen(h, s, { size: 4 });
    expect(none.statusCode).toBe(409);
    expect(none.json().error.code).toBe('NO_ELIGIBLE_STUDENTS');
  });

  it('is refused for a session that has not started', async () => {
    const s = await h.newSession();
    const res = await gen(h, s);
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('SESSION_NOT_STARTED');
  });

  it('treats a repeated generate request (same request id) as one round', async () => {
    const s = await h.openSession();
    await h.checkInStudents(s, 10);
    const requestId = randomUUID();
    await gen(h, s, { size: 3, requestId });
    await gen(h, s, { size: 3, requestId });
    const both = await Promise.all([
      gen(h, s, { size: 3, requestId }),
      gen(h, s, { size: 3, requestId }),
    ]);
    expect(both.every((r) => r.statusCode === 201)).toBe(true);
    expect(await h.count('SELECT 1 FROM spot_checks WHERE session_id = $1', [s])).toBe(1);
    expect(await h.count('SELECT 1 FROM spot_check_items WHERE session_id = $1', [s])).toBe(3);
  });

  it('is less likely, never impossible, for students sampled in recent sessions', async () => {
    const earlier = await h.openSession();
    const students = await h.checkInStudents(earlier, 4);
    await generateSpotCheck(
      h.db.appPool,
      { courseId: h.courseId, sessionId: earlier, actorId: h.lecturer.id, size: 2 },
      { defaultSize: 5, maxSize: 20, historySessions: 2 },
      seeded(1),
    );
    const sampledBefore = (
      await h.db.pool.query('SELECT student_id FROM spot_check_items WHERE session_id = $1', [
        earlier,
      ])
    ).rows.map((r) => r.student_id as string);
    expect(sampledBefore).toHaveLength(2);

    const next = await h.openSession(); // created after `earlier`, same course
    for (const st of students) expect((await h.scan(st, next)).statusCode).toBe(201);
    const l = (await (async () => {
      await generateSpotCheck(
        h.db.appPool,
        { courseId: h.courseId, sessionId: next, actorId: h.lecturer.id, size: 4 },
        { defaultSize: 5, maxSize: 20, historySessions: 2 },
        seeded(2),
      );
      return list(h, next);
    })()) as Listing;
    expect(allItems(l)).toHaveLength(4); // still eligible: all four were drawn
    const weights = (
      await h.db.pool.query(
        'SELECT student_id, weight::float AS weight FROM spot_check_items WHERE session_id = $1',
        [next],
      )
    ).rows;
    for (const w of weights)
      expect(w.weight).toBeCloseTo(sampledBefore.includes(w.student_id) ? 0.3 : 1);

    // With the history window set to zero, the earlier sample is ignored.
    const third = await h.openSession();
    for (const st of students) await h.scan(st, third);
    await generateSpotCheck(
      h.db.appPool,
      { courseId: h.courseId, sessionId: third, actorId: h.lecturer.id, size: 4 },
      { defaultSize: 5, maxSize: 20, historySessions: 0 },
      seeded(3),
    );
    const flat = (
      await h.db.pool.query(
        'SELECT DISTINCT weight::float AS weight FROM spot_check_items WHERE session_id = $1',
        [third],
      )
    ).rows;
    expect(flat).toEqual([{ weight: 1 }]);
  });

  it('cannot be listed or run by students', async () => {
    const s = await h.openSession();
    const [stu] = await h.checkInStudents(s, 1);
    expect((await h.get(`${base(h.courseId, s)}/spot-checks`, stu!.cookie)).statusCode).toBe(403);
    expect((await h.post(`${base(h.courseId, s)}/spot-checks`, {}, stu!.cookie)).statusCode).toBe(
      403,
    );
    expect(await h.count('SELECT 1 FROM spot_checks WHERE session_id = $1', [s])).toBe(0);
  });
});

describe('recording what the checker found', () => {
  async function oneItem(): Promise<{ s: string; item: Item; attendanceRecordedAt: Date }> {
    const s = await h.openSession();
    await h.checkInStudents(s, 1);
    const item = allItems((await gen(h, s, { size: 1 })).json())[0]!;
    const at = (
      await h.db.pool.query('SELECT recorded_at FROM attendance_records WHERE id = $1', [
        item.attendanceId,
      ])
    ).rows[0]!.recorded_at as Date;
    return { s, item, attendanceRecordedAt: at };
  }
  const attendance = async (id: string) =>
    (
      await h.db.pool.query(
        'SELECT status::text AS status, current_rev_no, recorded_at FROM attendance_records WHERE id = $1',
        [id],
      )
    ).rows[0]!;

  it('VERIFIED needs a method, records it, and leaves the attendance record exactly as it was', async () => {
    const { s, item, attendanceRecordedAt } = await oneItem();
    const noMethod = await result(h, s, item.id, { outcome: 'VERIFIED' });
    expect(noMethod.statusCode).toBe(400);
    expect(await h.count('SELECT 1 FROM spot_check_events WHERE item_id = $1', [item.id])).toBe(0);

    const ok = await result(h, s, item.id, verifiedBody);
    expect(ok.statusCode).toBe(200);
    const updated = allItems(ok.json())[0]!;
    expect(updated.state).toBe('VERIFIED');
    expect(updated.history[0]).toMatchObject({
      from: 'PENDING',
      to: 'VERIFIED',
      method: 'STUDENT_ID_CARD',
    });

    const rec = await attendance(item.attendanceId);
    expect(rec).toMatchObject({ status: 'PRESENT', current_rev_no: 1 });
    expect(rec.recorded_at.getTime()).toBe(attendanceRecordedAt.getTime()); // the original check-in time is untouched
    expect(await h.count('SELECT 1 FROM attendance_records WHERE session_id = $1', [s])).toBe(1); // no duplicate
    expect(await h.count('SELECT 1 FROM attendance_disputes WHERE session_id = $1', [s])).toBe(0);
  });

  it('NOT_PRESENT must be explained, and opens a dispute instead of changing the attendance', async () => {
    const { s, item, attendanceRecordedAt } = await oneItem();
    for (const explanation of [undefined, '', 'no', '         ']) {
      const res = await result(h, s, item.id, {
        outcome: 'NOT_PRESENT',
        ...(explanation === undefined ? {} : { explanation }),
      });
      expect(res.statusCode, String(explanation)).toBe(400);
    }
    expect(await h.count('SELECT 1 FROM attendance_disputes WHERE session_id = $1', [s])).toBe(0);

    const ok = await result(h, s, item.id, missingBody);
    expect(ok.statusCode).toBe(200);
    const updated = allItems(ok.json())[0]!;
    expect(updated).toMatchObject({ state: 'NOT_PRESENT', disputeState: 'OPEN' });

    // The student is neither rejected nor penalised: still present, same revision, same time.
    const rec = await attendance(item.attendanceId);
    expect(rec).toMatchObject({ status: 'PRESENT', current_rev_no: 1 });
    expect(rec.recorded_at.getTime()).toBe(attendanceRecordedAt.getTime());
    expect(
      await h.count(`SELECT 1 FROM attendance_disputes WHERE session_id = $1 AND state = 'OPEN'`, [
        s,
      ]),
    ).toBe(1);
    expect(await h.audit('DISPUTE_OPENED', s)).toHaveLength(1);
    const recorded = await h.audit('SPOT_CHECK_RESULT_RECORDED', s);
    expect(recorded[0]!.summary).toMatchObject({
      from: 'PENDING',
      to: 'NOT_PRESENT',
      correction: false,
    });
    expect(recorded[0]!.actor_type).toBe('LECTURER');
  });

  it('COULD_NOT_VERIFY stays unresolved, opens nothing, and can be settled later', async () => {
    const { s, item } = await oneItem();
    const res = await result(h, s, item.id, { outcome: 'COULD_NOT_VERIFY' });
    expect(res.statusCode).toBe(200);
    expect((res.json() as Listing).summary).toMatchObject({
      couldNotVerify: 1,
      pending: 0,
      verified: 0,
      notPresent: 0,
    });
    expect(await h.count('SELECT 1 FROM attendance_disputes WHERE session_id = $1', [s])).toBe(0);
    expect((await attendance(item.attendanceId)).status).toBe('PRESENT');

    const later = await result(h, s, item.id, verifiedBody);
    expect(later.statusCode).toBe(200);
    expect(allItems(later.json())[0]!.history.map((e) => `${e.from}>${e.to}`)).toEqual([
      'PENDING>COULD_NOT_VERIFY',
      'COULD_NOT_VERIFY>VERIFIED',
    ]);
  });

  it('enforces the transition rules on the server', async () => {
    const { s, item } = await oneItem();
    await result(h, s, item.id, verifiedBody);
    for (const body of [verifiedBody, { outcome: 'COULD_NOT_VERIFY' }]) {
      const res = await result(h, s, item.id, body);
      expect(res.statusCode).toBe(409);
      expect(res.json().error.code).toBe('INVALID_TRANSITION');
    }
    // A correction to "not present" needs an explanation.
    expect((await result(h, s, item.id, { outcome: 'NOT_PRESENT' })).statusCode).toBe(400);
    expect((await result(h, s, item.id, missingBody)).statusCode).toBe(200);
    expect((await result(h, s, item.id, missingBody)).statusCode).toBe(409); // already not present
    expect((await result(h, s, item.id, { outcome: 'COULD_NOT_VERIFY' })).statusCode).toBe(409);
    expect(
      (await h.audit('SPOT_CHECK_RESULT_RECORDED', s)).map((a) => a.summary.correction),
    ).toEqual([false, true]);
  });

  it('correcting "not present" to "verified" upholds the dispute, with the reason recorded', async () => {
    const { s, item } = await oneItem();
    await result(h, s, item.id, missingBody);
    expect(
      (await result(h, s, item.id, { outcome: 'VERIFIED', method: 'ROSTER_PHOTO' })).statusCode,
    ).toBe(400); // correction needs a reason
    const fixed = await result(h, s, item.id, {
      outcome: 'VERIFIED',
      method: 'ROSTER_PHOTO',
      explanation: 'Found them at the back row, photo matches.',
    });
    expect(fixed.statusCode).toBe(200);
    expect(allItems(fixed.json())[0]).toMatchObject({
      state: 'VERIFIED',
      disputeState: 'RESOLVED_UPHELD',
    });
    const note = (
      await h.db.pool.query(
        `SELECT note FROM attendance_dispute_events WHERE kind = 'RESOLVED_UPHELD'`,
      )
    ).rows.at(-1)!.note as string;
    expect(note).toContain('Found them at the back row');
    expect((await attendance(item.attendanceId)).status).toBe('PRESENT');
  });

  it('is safe to submit twice: one event, one dispute, even all at once', async () => {
    const { s, item } = await oneItem();
    const requestId = randomUUID();
    const burst = await Promise.all(
      Array.from({ length: 6 }, () => result(h, s, item.id, missingBody, requestId)),
    );
    expect(burst.every((r) => r.statusCode === 200)).toBe(true);
    expect(await h.count('SELECT 1 FROM spot_check_events WHERE item_id = $1', [item.id])).toBe(1);
    expect(await h.count('SELECT 1 FROM attendance_disputes WHERE session_id = $1', [s])).toBe(1);
    expect(await h.audit('SPOT_CHECK_RESULT_RECORDED', s)).toHaveLength(1);

    const reused = await result(h, s, item.id, verifiedBody, requestId);
    expect(reused.statusCode).toBe(409);
    expect(reused.json().error.code).toBe('REQUEST_ID_REUSED');
  });

  it('keeps the state and its history in step at the database level, whatever the application does', async () => {
    const { item } = await oneItem();
    // An illegal transition is refused by the table itself.
    await expect(
      h.db.appPool.query(
        `INSERT INTO spot_check_events (item_id, event_no, from_state, to_state, method, request_id, actor_user_id)
         VALUES ($1, 1, 'PENDING', 'VERIFIED', 'STUDENT_ID_CARD', gen_random_uuid(), $2),
                ($1, 2, 'VERIFIED', 'COULD_NOT_VERIFY', NULL, gen_random_uuid(), $2)`,
        [item.id, h.lecturer.id],
      ),
    ).rejects.toMatchObject({ code: '23514' });
    // A state with no matching event cannot be committed.
    const c = await h.db.appPool.connect();
    try {
      await c.query('BEGIN');
      await c.query(
        `UPDATE spot_check_items SET state = 'VERIFIED', current_event_no = 1 WHERE id = $1`,
        [item.id],
      );
      await expect(c.query('COMMIT')).rejects.toMatchObject({ code: '23503' });
    } finally {
      await c.query('ROLLBACK').catch(() => undefined);
      c.release();
    }
    expect(
      allItems(
        await list(
          h,
          (
            await h.db.pool.query('SELECT session_id FROM spot_check_items WHERE id = $1', [
              item.id,
            ])
          ).rows[0]!.session_id as string,
        ),
      )[0]!.state,
    ).toBe('PENDING');
  });

  it('cannot be submitted by a student, or for a different session or lecturer', async () => {
    const { s, item } = await oneItem();
    const [stu] = await createBulkStudents(h.db, 1);
    expect(
      (
        await result(
          { ...h, post: (u: string, p: unknown) => h.post(u, p, stu!.cookie) } as Harness,
          s,
          item.id,
          verifiedBody,
        )
      ).statusCode,
    ).toBe(403);
    const elsewhere = await h.openSession();
    expect((await result(h, elsewhere, item.id, verifiedBody)).statusCode).toBe(404); // right item, wrong session
    expect(
      (
        await h.post(
          `${base(h.otherCourseId, s)}/spot-checks/items/${item.id}/result`,
          { requestId: randomUUID(), ...verifiedBody },
          h.other.cookie,
        )
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await h.post(
          `${base(h.courseId, s)}/spot-checks/items/${item.id}/result`,
          { requestId: randomUUID(), ...verifiedBody },
          h.other.cookie,
        )
      ).statusCode,
    ).toBe(404);
    expect(await h.count('SELECT 1 FROM spot_check_events WHERE item_id = $1', [item.id])).toBe(0);
  });
});

describe('risk indicators raise a chance to be asked, and nothing more', () => {
  let hf: Harness;
  beforeAll(async () => {
    hf = await createHarness({ DEVICE_POLICY: 'FLAG' });
  });
  afterAll(async () => {
    await hf?.close();
  });

  it('weights a check-in the system flagged for a shared device, and explains why', async () => {
    const s = await hf.openSession();
    const shared = randomUUID();
    const pair = await createBulkStudents(hf.db, 2);
    for (const st of pair) expect((await hf.scan(st, s, shared)).statusCode).toBe(201); // recorded; flagged, not blocked
    await hf.checkInStudents(s, 3);

    const l = (await gen(hf, s, { size: 5 })).json() as Listing;
    const byStudent = new Map(allItems(l).map((i) => [i.attendanceId, i]));
    const flagged = (
      await hf.db.pool.query(
        `SELECT attendance_id FROM investigation_flags WHERE session_id = $1 AND origin = 'SYSTEM'`,
        [s],
      )
    ).rows.map((r) => r.attendance_id as string);
    expect(flagged).toHaveLength(2);
    for (const id of flagged) {
      expect(byStudent.get(id)).toMatchObject({
        selectionReason: 'RISK_WEIGHTED',
        riskFactors: ['DEVICE_SHARED_FLAG'],
      });
    }
    const plain = allItems(l).filter((i) => !flagged.includes(i.attendanceId));
    expect(plain.every((i) => i.selectionReason === 'RANDOM' && i.riskFactors.length === 0)).toBe(
      true,
    );
    const weights = (
      await hf.db.pool.query(
        'SELECT weight::float AS w, selection_reason FROM spot_check_items WHERE session_id = $1 ORDER BY weight',
        [s],
      )
    ).rows;
    expect(weights.map((w) => w.w)).toEqual([1, 1, 1, 2, 2]);
    // The rationale is on the audit trail, by item and reason rather than by name.
    const audit = (await hf.audit('SPOT_CHECK_GENERATED', s))[0]!;
    expect(JSON.stringify(audit.summary)).toContain('DEVICE_SHARED_FLAG');
  });

  it('does NOT treat a shared network address as a risk', async () => {
    const s = await hf.openSession();
    const crowd = await createBulkStudents(hf.db, 6);
    const sameIp = '203.0.113.9';
    const { mintToken, parseKeyring } = await import('../../src/qr/token.js');
    const { TEST_CONFIG } = await import('../helpers/app.js');
    const keyring = parseKeyring(TEST_CONFIG.QR_KEYS, TEST_CONFIG.QR_ACTIVE_KID);
    const ms = Number(
      (
        await hf.db.pool.query(
          `SELECT floor(extract(epoch FROM clock_timestamp())*1000)::bigint AS ms`,
        )
      ).rows[0]!.ms,
    );
    for (const st of crowd) {
      const r = await post(
        hf.app,
        '/checkins',
        {
          token: mintToken(keyring, s, ms).token,
          clientAttemptId: randomUUID(),
          deviceId: randomUUID(),
        },
        { cookie: st.cookie, ip: sameIp },
      );
      expect(r.statusCode).toBe(201);
    }
    const l = (await gen(hf, s, { size: 6 })).json() as Listing;
    expect(
      allItems(l).every((i) => i.riskFactors.length === 0 && i.selectionReason === 'RANDOM'),
    ).toBe(true);
  });

  it('never changes attendance, raises flags or opens disputes just by selecting someone', async () => {
    const s = await hf.openSession();
    const shared = randomUUID();
    for (const st of await createBulkStudents(hf.db, 3)) await hf.scan(st, s, shared);
    const flagsBefore = await hf.count('SELECT 1 FROM investigation_flags WHERE session_id = $1', [
      s,
    ]);
    await gen(hf, s, { size: 3 });
    expect(
      await hf.count(
        `SELECT 1 FROM attendance_records WHERE session_id = $1 AND status = 'PRESENT'`,
        [s],
      ),
    ).toBe(3);
    expect(
      await hf.count(
        'SELECT 1 FROM attendance_revisions r JOIN attendance_records a ON a.id = r.attendance_id WHERE a.session_id = $1 AND r.rev_no > 1',
        [s],
      ),
    ).toBe(0);
    expect(await hf.count('SELECT 1 FROM attendance_disputes WHERE session_id = $1', [s])).toBe(0);
    expect(await hf.count('SELECT 1 FROM investigation_flags WHERE session_id = $1', [s])).toBe(
      flagsBefore,
    );
  });

  it('raises the chance for a student an earlier check found absent, until the lecturer upholds that record', async () => {
    const first = await hf.openSession();
    const students = await hf.checkInStudents(first, 3);
    const target = allItems((await gen(hf, first, { size: 3 })).json() as Listing)[0]!;
    await result(hf, first, target.id, missingBody);
    const owner = (
      await hf.db.pool.query('SELECT student_id FROM spot_check_items WHERE id = $1', [target.id])
    ).rows[0]!.student_id as string;

    const second = await hf.openSession();
    for (const st of students) await hf.scan(st, second);
    await gen(hf, second, { size: 3 });
    const rowOf = async (sessionId: string) =>
      (
        await hf.db.pool.query(
          'SELECT risk_factors, weight::float AS w FROM spot_check_items WHERE session_id = $1 AND student_id = $2',
          [sessionId, owner],
        )
      ).rows[0]!;
    expect(await rowOf(second)).toMatchObject({ risk_factors: ['PRIOR_NOT_PRESENT_RESULT'] });

    // The lecturer looks into it, upholds the record, and the earlier finding stops counting.
    const dispute = (await hf.get(`${base(hf.courseId, first)}/disputes`)).json().disputes[0]
      .id as string;
    expect(
      (
        await hf.post(`${base(hf.courseId, first)}/disputes/${dispute}/resolve`, {
          resolution: 'UPHOLD',
          explanation: 'They were in the lab next door; confirmed.',
        })
      ).statusCode,
    ).toBe(200);
    const third = await hf.openSession();
    for (const st of students) await hf.scan(st, third);
    await gen(hf, third, { size: 3 });
    expect(await rowOf(third)).toMatchObject({ risk_factors: [] });
  });
});

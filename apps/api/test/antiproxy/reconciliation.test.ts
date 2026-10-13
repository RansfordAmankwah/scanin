import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { allowedDifference, classify } from '../../src/antiproxy/reconciliation.js';
import { base, createHarness, type Harness } from './harness.js';

let h: Harness;

beforeAll(async () => {
  h = await createHarness();
});
afterAll(async () => {
  await h?.close();
});

const settings = { tolerancePercent: 15, toleranceMin: 3, headcountMax: 2000, staleMinutes: 30 };

const reconcile = async (sessionId: string) =>
  (await h.get(`${base(h.courseId, sessionId)}/reconciliation`)).json();
const setCount = (sessionId: string, headcount: unknown, explanation?: string) =>
  h.put(`${base(h.courseId, sessionId)}/headcount`, {
    headcount,
    ...(explanation ? { explanation } : {}),
  });

describe('the tolerance rule (pure arithmetic)', () => {
  it('allows the larger of a fixed minimum and a percentage of the headcount', () => {
    expect(allowedDifference(10, settings)).toBe(3); // 15% of 10 is 2, the minimum of 3 wins
    expect(allowedDifference(100, settings)).toBe(15);
    expect(allowedDifference(0, settings)).toBe(3);
  });

  it('classifies each situation', () => {
    expect(classify(null, 5, settings).status).toBe('NO_HEADCOUNT');
    expect(classify(20, 20, settings)).toMatchObject({ status: 'CONSISTENT', difference: 0 });
    expect(classify(20, 23, settings).status).toBe('CONSISTENT'); // exactly at the tolerance
    expect(classify(20, 24, settings).status).toBe('REVIEW_RECOMMENDED'); // one over
    expect(classify(20, 17, settings).status).toBe('CONSISTENT');
    expect(classify(20, 16, settings).status).toBe('MORE_PEOPLE_THAN_RECORDS'); // not suspicious
  });
});

describe('reconciling a real session', () => {
  it('shows "no headcount" until one is recorded, and says so plainly', async () => {
    const s = await h.openSession();
    await h.checkInStudents(s, 3);
    const r = await reconcile(s);
    expect(r).toMatchObject({
      status: 'NO_HEADCOUNT',
      headcount: null,
      recordedAttendance: 3,
      difference: null,
    });
    expect(r.limits.headcountMax).toBe(2000);
  });

  it('is consistent when the headcount equals the attendance total', async () => {
    const s = await h.openSession();
    await h.checkInStudents(s, 6);
    const res = await setCount(s, 6);
    expect(res.statusCode).toBe(200);
    expect(res.json().reconciliation).toMatchObject({
      status: 'CONSISTENT',
      difference: 0,
      recordedAttendance: 6,
    });
    expect(await h.audit('RECONCILIATION_FLAGGED', s)).toHaveLength(0);
  });

  it('flags attendance that exceeds the headcount beyond the tolerance, as a review signal only', async () => {
    const s = await h.openSession();
    const students = await h.checkInStudents(s, 12);
    const res = await setCount(s, 5);
    const r = res.json().reconciliation;
    expect(r).toMatchObject({
      status: 'REVIEW_RECOMMENDED',
      recordedAttendance: 12,
      difference: 7,
      tolerance: { percent: 15, minimum: 3, allowed: 3 },
    });
    // Evidence it is audited, with the reasons.
    const flagged = await h.audit('RECONCILIATION_FLAGGED', s);
    expect(flagged).toHaveLength(1);
    expect(flagged[0]!.summary).toMatchObject({
      headcount: 5,
      recorded: 12,
      difference: 7,
      allowed: 3,
    });
    // And nothing happened to anyone's attendance: no rejection, no invalidation, no penalty.
    expect(
      await h.count(
        `SELECT 1 FROM attendance_records WHERE session_id = $1 AND status = 'PRESENT'`,
        [s],
      ),
    ).toBe(12);
    expect(
      await h.count(
        'SELECT 1 FROM attendance_revisions r JOIN attendance_records a ON a.id = r.attendance_id WHERE a.session_id = $1 AND r.rev_no > 1',
        [s],
      ),
    ).toBe(0);
    expect(await h.count('SELECT 1 FROM attendance_disputes WHERE session_id = $1', [s])).toBe(0);
    expect(await h.count('SELECT 1 FROM investigation_flags WHERE session_id = $1', [s])).toBe(0);
    // Every student can still check in again and is told it is recorded.
    expect((await h.scan(students[0]!, s)).statusCode).toBe(200);
  });

  it('stays consistent when records exceed the headcount by no more than the tolerance', async () => {
    const s = await h.openSession();
    await h.checkInStudents(s, 12);
    const r = (await setCount(s, 10)).json().reconciliation; // 2 over, 3 allowed
    expect(r).toMatchObject({ status: 'CONSISTENT', difference: 2 });
  });

  it('reports fewer records than people as informational, never as a discrepancy', async () => {
    const s = await h.openSession();
    await h.checkInStudents(s, 4);
    const r = (await setCount(s, 30)).json().reconciliation;
    expect(r.status).toBe('MORE_PEOPLE_THAN_RECORDS');
    expect(await h.audit('RECONCILIATION_FLAGGED', s)).toHaveLength(0);
  });

  it('refuses a missing, malformed, negative or unreasonable headcount and records nothing', async () => {
    const s = await h.openSession();
    for (const bad of [undefined, null, 'twelve', -1, 1.5, 2001, 1e9, Number.NaN, {}, []]) {
      const res = await setCount(s, bad);
      expect(res.statusCode, JSON.stringify(bad)).toBe(400);
      expect(res.json().error.code).toBe('INVALID_HEADCOUNT');
    }
    expect(await h.count('SELECT 1 FROM session_headcounts WHERE session_id = $1', [s])).toBe(0);
    expect((await setCount(s, 0)).statusCode).toBe(200); // zero is a real answer
    expect((await setCount(s, 2000)).statusCode).toBe(200); // and the limit itself is allowed
  });

  it('cannot be recorded before the session has started', async () => {
    const s = await h.newSession();
    const res = await setCount(s, 5);
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('SESSION_NOT_STARTED');
  });

  it('keeps every correction: old value, new value, who, when and why, in the table and the audit trail', async () => {
    const s = await h.openSession();
    await h.checkInStudents(s, 8);
    expect((await setCount(s, 6)).statusCode).toBe(200);
    const fixed = await setCount(s, 9, 'Recounted after the break');
    expect(fixed.statusCode).toBe(200);

    const rows = (
      await h.db.pool.query(
        'SELECT rev_no, headcount, previous_headcount, explanation, recorded_by, recorded_at FROM session_headcounts WHERE session_id = $1 ORDER BY rev_no',
        [s],
      )
    ).rows;
    expect(rows.map((r) => [r.rev_no, r.headcount, r.previous_headcount])).toEqual([
      [1, 6, null],
      [2, 9, 6],
    ]);
    expect(rows[1].explanation).toBe('Recounted after the break');
    expect(
      rows.every((r) => r.recorded_by === h.lecturer.id && r.recorded_at instanceof Date),
    ).toBe(true);

    expect((await h.audit('HEADCOUNT_RECORDED', s))[0]!.summary).toMatchObject({
      revNo: 1,
      previous: null,
      new: 6,
    });
    const corrected = await h.audit('HEADCOUNT_CORRECTED', s);
    expect(corrected).toHaveLength(1);
    expect(corrected[0]!.summary).toMatchObject({
      revNo: 2,
      previous: 6,
      new: 9,
      explanation: 'Recounted after the break',
    });
    expect(corrected[0]!.actor_type).toBe('LECTURER');
    expect((fixed.json().reconciliation.history as unknown[]).length).toBe(2);
  });

  it('treats re-sending the same number as no change: no new revision, no audit noise', async () => {
    const s = await h.openSession();
    await h.checkInStudents(s, 3);
    expect((await setCount(s, 3)).json().unchanged).toBe(false);
    expect((await setCount(s, 3)).json().unchanged).toBe(true);
    expect(await h.count('SELECT 1 FROM session_headcounts WHERE session_id = $1', [s])).toBe(1);
    expect(await h.audit('HEADCOUNT_RECORDED', s)).toHaveLength(1);
  });

  it('follows attendance as it changes, with no recalculation step', async () => {
    const s = await h.openSession();
    await h.checkInStudents(s, 12);
    await setCount(s, 5);
    expect((await reconcile(s)).status).toBe('REVIEW_RECOMMENDED');

    // A lecturer invalidates three records: recorded attendance falls and the status follows.
    const roster = (await h.get(`${base(h.courseId, s)}/attendance`)).json().records as Array<{
      attendanceId: string;
    }>;
    for (const rec of roster.slice(0, 4)) {
      const res = await h.post(`${base(h.courseId, s)}/attendance/${rec.attendanceId}/invalidate`, {
        category: 'INCORRECT_ENTRY',
        explanation: 'Entered by mistake, confirmed in person.',
      });
      expect(res.statusCode).toBe(200);
    }
    const after = await reconcile(s);
    expect(after).toMatchObject({
      recordedAttendance: 8,
      invalidated: 4,
      difference: 3,
      status: 'CONSISTENT',
    });

    // More students check in: it flips back, again without touching the headcount.
    await h.checkInStudents(s, 5);
    expect((await reconcile(s)).status).toBe('REVIEW_RECOMMENDED');
  });

  it('audits the flag being cleared when a corrected headcount resolves the discrepancy', async () => {
    const s = await h.openSession();
    await h.checkInStudents(s, 12);
    await setCount(s, 5);
    expect(
      (await setCount(s, 11, 'I missed a whole row the first time')).json().reconciliation.status,
    ).toBe('CONSISTENT');
    expect(await h.audit('RECONCILIATION_FLAGGED', s)).toHaveLength(1);
    expect(await h.audit('RECONCILIATION_CLEARED', s)).toHaveLength(1);
  });

  it('marks a headcount as possibly out of date only when it is old AND people checked in since', async () => {
    const s = await h.openSession();
    await h.checkInStudents(s, 2);
    await setCount(s, 2);
    expect((await reconcile(s)).stale.isStale).toBe(false);

    // Age the count and the check-ins it covered (the owner connection can; the application cannot
    // rewrite history), then let three more students check in afterwards.
    await h.db.pool.query(
      `UPDATE session_headcounts SET recorded_at = recorded_at - interval '45 minutes' WHERE session_id = $1`,
      [s],
    );
    await h.db.pool.query(
      `UPDATE attendance_records SET recorded_at = recorded_at - interval '50 minutes' WHERE session_id = $1`,
      [s],
    );
    expect((await reconcile(s)).stale.isStale).toBe(false); // old, but no one has checked in since
    await h.checkInStudents(s, 3);
    expect((await reconcile(s)).stale).toMatchObject({ isStale: true, checkInsSince: 3 });
  });

  it('lets the lecturer record a written response to a flag, and keeps it', async () => {
    const s = await h.openSession();
    await h.checkInStudents(s, 12);
    const none = await h.post(`${base(h.courseId, s)}/reconciliation/notes`, {
      note: 'Six arrived late and left early',
    });
    expect(none.statusCode).toBe(409); // no headcount yet
    await setCount(s, 5);
    const short = await h.post(`${base(h.courseId, s)}/reconciliation/notes`, { note: 'late' });
    expect(short.statusCode).toBe(400);
    const ok = await h.post(`${base(h.courseId, s)}/reconciliation/notes`, {
      note: 'Six arrived late and left early',
    });
    expect(ok.statusCode).toBe(201);
    expect(ok.json().notes[0]).toMatchObject({
      note: 'Six arrived late and left early',
      statusAtTime: 'REVIEW_RECOMMENDED',
    });
    expect((await h.audit('RECONCILIATION_NOTE_ADDED', s))[0]!.summary).toMatchObject({
      statusAtTime: 'REVIEW_RECOMMENDED',
    });
  });

  it('keeps revisions contiguous when two corrections arrive at the same moment', async () => {
    const s = await h.openSession();
    await h.checkInStudents(s, 2);
    const results = await Promise.all([
      setCount(s, 4),
      setCount(s, 5),
      setCount(s, 6),
      setCount(s, 7),
    ]);
    expect(results.every((r) => r.statusCode === 200)).toBe(true);
    const revs = (
      await h.db.pool.query(
        'SELECT rev_no FROM session_headcounts WHERE session_id = $1 ORDER BY rev_no',
        [s],
      )
    ).rows.map((r) => r.rev_no);
    expect(revs).toEqual([1, 2, 3, 4]);
  });

  it('uses the tolerance from configuration, not a number buried in the code', async () => {
    const s = await h.openSession();
    await h.checkInStudents(s, 14);
    expect((await setCount(s, 10)).json().reconciliation.status).toBe('REVIEW_RECOMMENDED'); // 4 over, 3 allowed

    const lenient = await h.withConfig({ HEADCOUNT_TOLERANCE_PERCENT: 50 });
    try {
      const res = await lenient.app.inject({
        method: 'GET',
        url: `${base(h.courseId, s)}/reconciliation`,
        headers: { cookie: h.lecturer.cookie },
      });
      expect(res.json()).toMatchObject({
        status: 'CONSISTENT',
        tolerance: { percent: 50, allowed: 5 },
      });
    } finally {
      await lenient.close();
    }
  });
});

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { drawSample, type Candidate } from '../../src/antiproxy/spotChecks.js';
import { createBulkStudents, type BulkStudent } from '../helpers/students.js';
import { base, createHarness, type Harness } from './harness.js';

/**
 * THE ATTACK THIS FEATURE EXISTS FOR: one person carrying several phones, signed in to other
 * students' accounts, scanning the projected code for classmates who are not in the room.
 *
 * These tests are the demonstration. They show which controls notice, what a lecturer is told, how
 * the person is caught or cleared, and, just as important, which versions of the attack still get
 * through. Nothing here claims to prove who is holding a phone.
 */
let h: Harness;
beforeAll(async () => {
  h = await createHarness();
});
afterAll(async () => {
  await h?.close();
});

interface Listing {
  rounds: Array<{ items: Array<{ id: string; attendanceId: string; disputeId: string | null }> }>;
}
const reconcile = async (s: string) =>
  (await h.get(`${base(h.courseId, s)}/reconciliation`)).json();

/** The room: `honest` students who are really there, and an attacker with `phones` accounts on separate phones. */
async function setUpRoom(honest: number, proxies: number) {
  const s = await h.openSession();
  const present = await h.checkInStudents(s, honest);
  const attackerOwn = (await h.checkInStudents(s, 1))[0]!; // the attacker's own account: really in the room
  const proxyAccounts = await h.checkInStudents(s, proxies); // each one scanned from a different phone
  return { s, present: [...present, attackerOwn], proxyAccounts };
}

describe('one attacker, five extra phones, five absent classmates', () => {
  it('is noticed by the headcount, found by a spot check, and cleaned up by the lecturer', async () => {
    const { s, present, proxyAccounts } = await setUpRoom(4, 5);
    expect(present).toHaveLength(5); // 4 honest students + the attacker are physically there
    const absent = new Set(proxyAccounts.map((p) => p.id));

    // 1. Nothing at the door stops it: every account scanned from its own phone, so each check-in
    //    looks perfectly legitimate on its own. Device binding does not (and cannot) see this.
    expect((await reconcile(s)).recordedAttendance).toBe(10);
    expect(await h.count('SELECT 1 FROM attendance_disputes WHERE session_id = $1', [s])).toBe(0);

    // 2. The lecturer counts the room: five people. Ten records is far beyond the tolerance.
    const counted = await h.put(`${base(h.courseId, s)}/headcount`, { headcount: 5 });
    expect(counted.json().reconciliation).toMatchObject({
      status: 'REVIEW_RECOMMENDED',
      recordedAttendance: 10,
      difference: 5,
    });
    // ...but it is only a signal. No one has been rejected or accused.
    expect(
      await h.count(
        `SELECT 1 FROM attendance_records WHERE session_id = $1 AND status = 'PRESENT'`,
        [s],
      ),
    ).toBe(10);

    // 3. A spot check of six students. Only five people are really present, so the sample MUST
    //    include at least one absent account, whatever the random draw is.
    const sample = (
      await h.post(`${base(h.courseId, s)}/spot-checks`, { size: 6 })
    ).json() as Listing;
    const picked = sample.rounds[0]!.items;
    expect(picked).toHaveLength(6);
    const owners = new Map(
      (
        await h.db.pool.query('SELECT id, student_id FROM spot_check_items WHERE session_id = $1', [
          s,
        ])
      ).rows.map((r) => [r.id as string, r.student_id as string]),
    );
    const caught = picked.filter((i) => absent.has(owners.get(i.id)!));
    expect(caught.length).toBeGreaterThanOrEqual(1);

    // 4. The checker walks the room. Real people show ID; the absent accounts cannot be found.
    for (const item of picked) {
      const here = !absent.has(owners.get(item.id)!);
      const res = await h.post(`${base(h.courseId, s)}/spot-checks/items/${item.id}/result`, {
        requestId: randomUUID(),
        ...(here
          ? { outcome: 'VERIFIED', method: 'STUDENT_ID_CARD' }
          : {
              outcome: 'NOT_PRESENT',
              explanation: 'Called the name and asked the row; nobody answered.',
            }),
      });
      expect(res.statusCode).toBe(200);
    }
    // The absent accounts are in dispute, still counted until a person decides.
    const open = (await h.get(`${base(h.courseId, s)}/disputes`)).json().disputes as Array<{
      id: string;
      state: string;
    }>;
    expect(open.filter((d) => d.state === 'OPEN')).toHaveLength(caught.length);
    expect((await reconcile(s)).recordedAttendance).toBe(10);

    // 5. The lecturer resolves each one with a written reason; each decision is audited.
    for (const d of open) {
      const res = await h.post(`${base(h.courseId, s)}/disputes/${d.id}/resolve`, {
        resolution: 'INVALIDATE',
        category: 'CONFIRMED_PROXY',
        explanation:
          'Not in the room when checked; the account holder confirmed a friend scanned it.',
      });
      expect(res.statusCode).toBe(200);
    }
    const after = await reconcile(s);
    expect(after.recordedAttendance).toBe(10 - caught.length);
    expect(after.invalidated).toBe(caught.length);
    expect(after.difference).toBeLessThan(5); // the numbers move toward the truth
    expect(await h.audit('ATTENDANCE_INVALIDATED', s)).toHaveLength(caught.length);
  });

  it('does not wrongly penalise honest students who happen to be sampled', async () => {
    const { s, present } = await setUpRoom(4, 3);
    await h.put(`${base(h.courseId, s)}/headcount`, { headcount: 5 });
    const honest = new Set(present.map((p) => p.id));
    const sample = (
      await h.post(`${base(h.courseId, s)}/spot-checks`, { size: 8 })
    ).json() as Listing;
    for (const item of sample.rounds[0]!.items) {
      const owner = (
        await h.db.pool.query('SELECT student_id FROM spot_check_items WHERE id = $1', [item.id])
      ).rows[0]!.student_id as string;
      if (honest.has(owner)) {
        await h.post(`${base(h.courseId, s)}/spot-checks/items/${item.id}/result`, {
          requestId: randomUUID(),
          outcome: 'VERIFIED',
          method: 'ROSTER_PHOTO',
        });
      }
    }
    // Every honest student who was checked is verified, still present, and has no dispute.
    for (const p of present) {
      const rec = (
        await h.db.pool.query(
          `SELECT a.status::text AS status, (SELECT count(*) FROM attendance_disputes d WHERE d.attendance_id = a.id)::int AS disputes
           FROM attendance_records a WHERE a.session_id = $1 AND a.student_id = $2`,
          [s, p.id],
        )
      ).rows[0]!;
      expect(rec).toMatchObject({ status: 'PRESENT', disputes: 0 });
    }
  });
});

describe('which versions of the attack still get through', () => {
  it('a small number of proxies stays inside the tolerance, so the headcount does not flag it', async () => {
    const { s } = await setUpRoom(8, 2); // 8 honest + the attacker = 9 really there; 2 absent accounts
    const res = await h.put(`${base(h.courseId, s)}/headcount`, { headcount: 9 });
    expect(res.json().reconciliation).toMatchObject({ status: 'CONSISTENT', difference: 2 });
    // The tolerance is deliberate: tighter would flag late arrivals and miscounts. It is a setting.
  });

  it('a small sample can miss: detection is probabilistic, never guaranteed', () => {
    // Seven students recorded, two of them absent proxies; the checker samples ONE student.
    const room: Candidate[] = Array.from({ length: 7 }, (_, i) => ({
      attendanceId: `a${i}`,
      studentId: `s${i}`,
      factors: [],
      recentlySampled: false,
      weight: 1,
    }));
    const proxies = new Set(['s5', 's6']);
    let x = 12345;
    const rng = () => ((x = (Math.imul(x, 1664525) + 1013904223) >>> 0) + 0.5) / 2 ** 32;
    let missed = 0;
    const trials = 6000;
    for (let i = 0; i < trials; i++)
      if (!proxies.has(drawSample(room, 1, rng)[0]!.studentId)) missed += 1;
    // Expected miss rate is 5/7, about 71%.
    expect(missed / trials).toBeGreaterThan(0.66);
    expect(missed / trials).toBeLessThan(0.77);
  });

  it('a proxy account that is also physically present is, correctly, verified: the check is about the room, not the account', async () => {
    const { s, proxyAccounts } = await setUpRoom(2, 1);
    const sample = (
      await h.post(`${base(h.courseId, s)}/spot-checks`, { size: 10 })
    ).json() as Listing;
    const item = sample.rounds[0]!.items.find((i) => i.attendanceId)!;
    const res = await h.post(`${base(h.courseId, s)}/spot-checks/items/${item.id}/result`, {
      requestId: randomUUID(),
      outcome: 'VERIFIED',
      method: 'OTHER_OFFICIAL_ID',
    });
    expect(res.statusCode).toBe(200);
    expect(proxyAccounts).toHaveLength(1);
  });
});

describe('the control that does work at the door: one phone, one student', () => {
  it('stops the cheaper version of the attack, one phone signed in to several accounts', async () => {
    const s = await h.openSession();
    const phone = randomUUID();
    const accounts: BulkStudent[] = await createBulkStudents(h.db, 4);
    const statuses: number[] = [];
    for (const a of accounts) statuses.push((await h.scan(a, s, phone)).statusCode);
    expect(statuses).toEqual([201, 403, 403, 403]);
    expect(await h.count('SELECT 1 FROM attendance_records WHERE session_id = $1', [s])).toBe(1);
  });
});

/**
 * The version of the attack the headcount and random spot check cannot reliably catch — several
 * phones, several accounts — is what face verification is for. A proxy's face does not match the
 * absent student's enrolled template, so every proxy lands on the in-person list by itself, with no
 * reliance on the luck of the random draw.
 */
describe('face verification catches the several-phones attack deterministically', () => {
  it('puts every proxy on the in-person list, whatever the random sample is', async () => {
    const courseId = await h.newCourse();
    await h.db.pool.query('UPDATE courses SET face_verification_enabled = true WHERE id = $1', [
      courseId,
    ]);
    const session = await h.openSession(courseId);

    // Four students enrolled with their own faces. Two are really here; two are absent, their
    // accounts scanned by one attacker on two phones.
    const everyone = await createBulkStudents(h.db, 4);
    const [h1, h2, p1, p2] = everyone;
    const present = new Set([h1!.id, h2!.id]);
    const att: Record<string, string> = {};
    const dev: Record<string, string> = {};
    for (const s of everyone) {
      const d = randomUUID();
      dev[s.id] = d;
      att[s.id] = (await h.scan(s, session, d)).json().attendanceId;
      const linkId = (
        await h.db.pool.query(
          'SELECT id FROM roster_links WHERE course_id = $1 AND student_id = $2',
          [courseId, s.id],
        )
      ).rows[0]!.id;
      await h.post('/me/biometric-consent', {}, s.cookie);
      const opened = await h.post(
        `/courses/${courseId}/face-enrollments`,
        { linkId, idMethod: 'STUDENT_ID_CARD' },
        h.lecturer.cookie,
      );
      await h.post(
        `/me/face-enrollments/${opened.json().sessionId}/complete`,
        { frames: [`subject:${s.id}`, 'live:true'] },
        s.cookie,
      );
    }

    // At check-in each phone captures a face. The two present students match; the two proxy phones
    // are held by the attacker, so their capture does not match the absent account's template.
    for (const s of everyone) {
      const ch = await h.post('/me/face-checks/challenge', { attendanceId: att[s.id] }, s.cookie);
      const face = present.has(s.id) ? s.id : 'the-attacker';
      const sub = await h.post(
        `/me/face-checks/${ch.json().challengeId}/frames`,
        { frames: [`subject:${face}`, 'live:true'], deviceId: dev[s.id] },
        s.cookie,
      );
      expect(sub.json().outcome).toBe(present.has(s.id) ? 'VERIFIED' : 'FAILED');
    }

    // The smallest possible random sample. The proxies are on the list regardless, as IN_PERSON_REQUIRED.
    await h.post(`${base(courseId, session)}/spot-checks`, { size: 1 });
    const items = (await h.get(`${base(courseId, session)}/spot-checks`))
      .json()
      .rounds.flatMap(
        (r: { items: Array<{ attendanceId: string; selectionReason: string }> }) => r.items,
      );
    const forced = items
      .filter((i: { selectionReason: string }) => i.selectionReason === 'IN_PERSON_REQUIRED')
      .map((i: { attendanceId: string }) => i.attendanceId);
    expect(forced.sort()).toEqual([att[p1!.id], att[p2!.id]].sort());
    // And the lecturer is never told why, only that an in-person check is required.
    const body = (await h.get(`${base(courseId, session)}/spot-checks`)).body.toLowerCase();
    expect(body).not.toContain('failed');
  });
});

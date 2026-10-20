import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { base, createHarness, type Harness } from '../antiproxy/harness.js';
import { createBulkStudents, type BulkStudent } from '../helpers/students.js';

/**
 * Phase 3: a face exception always puts the student on the in-person spot-check list, shown to the
 * lecturer only as "verify in person" — never the face sub-reason. An outage falls back to random
 * sampling, and a face-verified student is always included so the list does not reveal who failed.
 */
let harnesses: Harness[] = [];
afterEach(async () => {
  await Promise.all(harnesses.map((h) => h.close()));
  harnesses = [];
});

interface World {
  h: Harness;
  session: string;
  att: Record<string, string>;
  dev: Record<string, string>;
  students: { alice: BulkStudent; bob: BulkStudent; carol: BulkStudent; dave: BulkStudent };
}

/** A session with four students checked in: alice VERIFIED, bob FAILED, carol EXEMPT, dave UNAVAILABLE. */
async function world(): Promise<World> {
  const h = await createHarness();
  harnesses.push(h);
  await h.db.pool.query('UPDATE courses SET face_verification_enabled = true WHERE id = $1', [
    h.courseId,
  ]);
  const [alice, bob, carol, dave] = await createBulkStudents(h.db, 4);
  const students = { alice: alice!, bob: bob!, carol: carol!, dave: dave! };

  const session = await h.openSession();
  const att: Record<string, string> = {};
  const dev: Record<string, string> = {};
  for (const [name, s] of Object.entries(students)) {
    const d = randomUUID();
    dev[name] = d;
    const r = await h.scan(s, session, d);
    expect(r.statusCode).toBe(201);
    att[name] = r.json().attendanceId;
  }

  const enroll = async (name: string, subject: string) => {
    const s = students[name as keyof typeof students];
    const linkId = (
      await h.db.pool.query<{ id: string }>(
        'SELECT id FROM roster_links WHERE course_id = $1 AND student_id = $2',
        [h.courseId, s.id],
      )
    ).rows[0]!.id;
    await h.post('/me/biometric-consent', {}, s.cookie);
    const o = await h.post(
      `/courses/${h.courseId}/face-enrollments`,
      { linkId, idMethod: 'STUDENT_ID_CARD' },
      h.lecturer.cookie,
    );
    await h.post(
      `/me/face-enrollments/${o.json().sessionId}/complete`,
      { frames: [`subject:${subject}`, 'live:true'] },
      s.cookie,
    );
  };
  await enroll('alice', 'alice');
  await enroll('bob', 'bob');
  await enroll('dave', 'dave');
  // carol never consents or enrolls.

  const check = async (name: string, frames: string[]) => {
    const s = students[name as keyof typeof students];
    const ch = await h.post('/me/face-checks/challenge', { attendanceId: att[name] }, s.cookie);
    if (ch.json().outcome === 'EXEMPT') return 'EXEMPT';
    const sub = await h.post(
      `/me/face-checks/${ch.json().challengeId}/frames`,
      { frames, deviceId: dev[name] },
      s.cookie,
    );
    return sub.json().outcome;
  };
  expect(await check('alice', ['subject:alice', 'live:true'])).toBe('VERIFIED');
  expect(await check('bob', ['subject:zzz', 'live:true'])).toBe('FAILED');
  expect(await check('carol', [])).toBe('EXEMPT');
  expect(await check('dave', ['outage'])).toBe('UNAVAILABLE');

  return { h, session, att, dev, students };
}

const items = async (w: World) => {
  const list = (await w.h.get(`${base(w.h.courseId, w.session)}/spot-checks`)).json();
  return {
    body: (await w.h.get(`${base(w.h.courseId, w.session)}/spot-checks`)).body,
    rows: list.rounds.flatMap(
      (r: { items: Array<{ attendanceId: string; selectionReason: string }> }) => r.items,
    ) as Array<{ attendanceId: string; selectionReason: string }>,
  };
};

describe('face exceptions force an in-person check', () => {
  it('always includes failed and exempt students, as IN_PERSON_REQUIRED, on top of the random sample', async () => {
    const w = await world();
    const round = await w.h.post(`${base(w.h.courseId, w.session)}/spot-checks`, { size: 1 });
    expect(round.statusCode).toBe(201);
    const { rows } = await items(w);

    const forced = rows
      .filter((i) => i.selectionReason === 'IN_PERSON_REQUIRED')
      .map((i) => i.attendanceId);
    // bob (FAILED) and carol (EXEMPT) are forced; dave (UNAVAILABLE) is not.
    expect(forced.sort()).toEqual([w.att.bob, w.att.carol].sort());
    expect(forced).not.toContain(w.att.dave);
    // At least one face-verified student (alice) is included, so the list does not reveal failures.
    expect(rows.map((i) => i.attendanceId)).toContain(w.att.alice);
  });

  it('never discloses the face sub-reason to the lecturer', async () => {
    const w = await world();
    await w.h.post(`${base(w.h.courseId, w.session)}/spot-checks`, { size: 5 });
    const { body } = await items(w);
    const text = body.toLowerCase();
    for (const leak of ['face', 'liveness', 'exempt', 'failed', 'unavailable']) {
      expect(text).not.toContain(leak);
    }
    // Only ever the neutral reasons.
    const { rows } = await items(w);
    for (const r of rows) {
      expect(['RANDOM', 'RISK_WEIGHTED', 'IN_PERSON_REQUIRED']).toContain(r.selectionReason);
    }
  });

  it('leaves outcomes and disputes unchanged: a forced item can still be recorded and open a dispute', async () => {
    const w = await world();
    await w.h.post(`${base(w.h.courseId, w.session)}/spot-checks`, { size: 1 });
    const bobItem = (
      await w.h.db.pool.query<{ id: string }>(
        'SELECT id FROM spot_check_items WHERE session_id = $1 AND attendance_id = $2',
        [w.session, w.att.bob],
      )
    ).rows[0]!.id;
    const res = await w.h.post(
      `${base(w.h.courseId, w.session)}/spot-checks/items/${bobItem}/result`,
      {
        requestId: randomUUID(),
        outcome: 'NOT_PRESENT',
        explanation: 'Called the name, nobody there.',
      },
    );
    expect(res.statusCode).toBe(200);
    expect(
      await w.h.count('SELECT 1 FROM attendance_disputes WHERE attendance_id = $1', [w.att.bob]),
    ).toBe(1);
  });
});

describe('pilot metrics and the student view', () => {
  it('reports totals only, with no names or sub-reasons per student', async () => {
    const w = await world();
    await w.h.post(`${base(w.h.courseId, w.session)}/spot-checks`, { size: 1 });
    const res = await w.h.get(`/courses/${w.h.courseId}/face-metrics`);
    expect(res.statusCode).toBe(200);
    const m = res.json();
    expect(m).toMatchObject({
      attempted: 3, // alice, bob, dave (exempt is not an attempt)
      verified: 1,
      failed: 1,
      livenessRejected: 0,
      unavailable: 1,
      exempt: 1,
      forcedListSize: 2,
      notPresentAmongFaceVerified: 0,
    });
    expect(typeof m.medianScanToVerifiedSeconds === 'number').toBe(true);
    // Totals only: no student identifiers anywhere in the body.
    const text = res.body;
    for (const s of Object.values(w.students)) expect(text).not.toContain(s.studentId);
  });

  it('a student is not allowed to read the metrics', async () => {
    const w = await world();
    const res = await w.h.get(`/courses/${w.h.courseId}/face-metrics`, w.students.alice.cookie);
    expect(res.statusCode).toBe(403);
  });

  it('a forced student sees, on their own privacy page, that they were asked to verify in person', async () => {
    const w = await world();
    await w.h.post(`${base(w.h.courseId, w.session)}/spot-checks`, { size: 1 });
    const privacy = (await w.h.get('/me/privacy', w.students.bob.cookie)).json();
    expect(privacy.inPersonReasons.length).toBeGreaterThanOrEqual(1);
    expect(privacy.faceChecks.some((f: { outcome: string }) => f.outcome === 'FAILED')).toBe(true);
  });
});

import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import type { Config } from '../../src/config.js';
import { createHarness, type Harness } from '../antiproxy/harness.js';
import type { BulkStudent } from '../helpers/students.js';

/**
 * Phase 2: the face-check pipeline. A check never changes attendance; it only records an outcome.
 * Frames are never stored or logged, the challenge is single-use and device-bound, and a student
 * sees their own checks while a lecturer sees none of the detail.
 */
let harnesses: Harness[] = [];
afterEach(async () => {
  await Promise.all(harnesses.map((h) => h.close()));
  harnesses = [];
});

const SENTINEL = 'FRAME-SENTINEL-check';

async function faceHarness(overrides: Partial<Config> = {}): Promise<Harness> {
  const h = await createHarness(overrides);
  harnesses.push(h);
  await h.db.pool.query('UPDATE courses SET face_verification_enabled = true WHERE id = $1', [
    h.courseId,
  ]);
  return h;
}

/** Creates a student in the course and fully enrolls them as `subject` (so a matching check VERIFIES). */
async function enrolledStudent(h: Harness, subject: string): Promise<BulkStudent> {
  const session = await h.openSession();
  const [student] = await h.checkInStudents(session, 1);
  const linkId = (
    await h.db.pool.query<{ id: string }>(
      'SELECT id FROM roster_links WHERE course_id = $1 AND student_id = $2',
      [h.courseId, student!.id],
    )
  ).rows[0]!.id;
  expect((await h.post('/me/biometric-consent', {}, student!.cookie)).statusCode).toBe(200);
  const opened = await h.post(
    `/courses/${h.courseId}/face-enrollments`,
    { linkId, idMethod: 'STUDENT_ID_CARD' },
    h.lecturer.cookie,
  );
  const done = await h.post(
    `/me/face-enrollments/${opened.json().sessionId}/complete`,
    { frames: [`subject:${subject}`, 'live:true'] },
    student!.cookie,
  );
  expect(done.statusCode).toBe(201);
  return student!;
}

/** Checks the student in to a fresh session and returns the attendance id and device used. */
async function checkIn(h: Harness, student: BulkStudent) {
  const session = await h.openSession();
  const device = randomUUID();
  const res = await h.scan(student, session, device);
  expect(res.statusCode).toBe(201);
  expect(res.json().faceCheck).toEqual({ required: true });
  return { attendanceId: res.json().attendanceId as string, device, session };
}

const challenge = (h: Harness, student: BulkStudent, attendanceId: string) =>
  h.post('/me/face-checks/challenge', { attendanceId }, student.cookie);
const submit = (
  h: Harness,
  student: BulkStudent,
  challengeId: string,
  frames: string[],
  device: string,
) => h.post(`/me/face-checks/${challengeId}/frames`, { frames, deviceId: device }, student.cookie);

async function runCheck(h: Harness, student: BulkStudent, frames: string[]) {
  const { attendanceId, device } = await checkIn(h, student);
  const ch = await challenge(h, student, attendanceId);
  expect(ch.statusCode).toBe(200);
  const res = await submit(h, student, ch.json().challengeId, frames, device);
  return { res, attendanceId, device, challengeId: ch.json().challengeId as string };
}

describe('face-check outcomes', () => {
  it('a live, matching capture is VERIFIED, and records the score as detail', async () => {
    const h = await faceHarness();
    const student = await enrolledStudent(h, 'alice');
    const { res, attendanceId } = await runCheck(h, student, ['subject:alice', 'live:true']);
    expect(res.json()).toMatchObject({ outcome: 'VERIFIED' });

    const ev = (
      await h.db.pool.query(
        `SELECT outcome::text AS outcome, model_version FROM attendance_face_check_events WHERE attendance_id = $1`,
        [attendanceId],
      )
    ).rows[0]!;
    expect(ev).toMatchObject({ outcome: 'VERIFIED', model_version: 'fake-1.0' });
    const detail = (
      await h.db.pool.query(
        `SELECT liveness, match_score::float AS score FROM face_check_details d
           JOIN attendance_face_check_events e ON e.id = d.event_id WHERE e.attendance_id = $1`,
        [attendanceId],
      )
    ).rows[0]!;
    expect(detail).toMatchObject({ liveness: 'PASS', score: 1 });
    expect(await h.audit('FACE_CHECK_RECORDED')).toHaveLength(1);
  });

  it('a non-matching face FAILS, a non-live capture is LIVENESS_REJECTED, and neither touches attendance', async () => {
    const h = await faceHarness();
    const student = await enrolledStudent(h, 'alice');

    const failed = await runCheck(h, student, ['subject:bob', 'live:true']);
    expect(failed.res.json().outcome).toBe('FAILED');
    const spoof = await runCheck(h, student, ['subject:alice', 'live:false']);
    expect(spoof.res.json().outcome).toBe('LIVENESS_REJECTED');

    // Attendance is still PRESENT for both; a face check never changes it.
    const statuses = (
      await h.db.pool.query(
        `SELECT DISTINCT status::text FROM attendance_records WHERE student_id = $1`,
        [student.id],
      )
    ).rows.map((r) => r.status);
    expect(statuses).toEqual(['PRESENT']);
  });

  it('a verifier outage is UNAVAILABLE (so the student falls back to random sampling later)', async () => {
    const h = await faceHarness();
    const student = await enrolledStudent(h, 'alice');
    const { res } = await runCheck(h, student, ['outage']);
    expect(res.json().outcome).toBe('UNAVAILABLE');
  });

  it('a student without consent or enrollment is EXEMPT, with no challenge to complete', async () => {
    const h = await faceHarness();
    const session = await h.openSession();
    const [student] = await h.checkInStudents(session, 1); // never consents or enrolls
    const res = await h.scan(student!, await h.openSession(), randomUUID());
    const attendanceId = res.json().attendanceId;
    const ch = await challenge(h, student!, attendanceId);
    expect(ch.statusCode).toBe(200);
    expect(ch.json()).toEqual({ outcome: 'EXEMPT' });
    expect(
      (
        await h.db.pool.query(
          `SELECT outcome::text AS outcome FROM attendance_face_check_events WHERE attendance_id = $1`,
          [attendanceId],
        )
      ).rows[0]!.outcome,
    ).toBe('EXEMPT');
  });
});

describe('the challenge is single-use and bound to the device and token', () => {
  it('binds the challenge to the QR token id used at check-in', async () => {
    const h = await faceHarness();
    const student = await enrolledStudent(h, 'alice');
    const { attendanceId } = await checkIn(h, student);
    await challenge(h, student, attendanceId);
    const jtiOnChallenge = (
      await h.db.pool.query(
        'SELECT token_jti FROM face_check_challenges WHERE attendance_id = $1',
        [attendanceId],
      )
    ).rows[0]!.token_jti;
    const jtiOnScan = (
      await h.db.pool.query(
        `SELECT token_jti FROM scan_attempts WHERE attendance_id = $1 AND outcome = 'ACCEPTED'`,
        [attendanceId],
      )
    ).rows[0]!.token_jti;
    expect(jtiOnChallenge).toBe(jtiOnScan);
  });

  it('refuses a capture from a different device, and audits it as a security event', async () => {
    const h = await faceHarness();
    const student = await enrolledStudent(h, 'alice');
    const { attendanceId } = await checkIn(h, student);
    const ch = await challenge(h, student, attendanceId);
    const wrong = await submit(
      h,
      student,
      ch.json().challengeId,
      ['subject:alice', 'live:true'],
      randomUUID(),
    );
    expect(wrong.statusCode).toBe(403);
    expect(wrong.json().error.code).toBe('WRONG_DEVICE');
    expect(await h.audit('FACE_CHECK_WRONG_DEVICE')).toHaveLength(1);
    // The challenge was not consumed: the real device can still use it.
    expect(
      (
        await h.db.pool.query('SELECT used_at FROM face_check_challenges WHERE id = $1', [
          ch.json().challengeId,
        ])
      ).rows[0]!.used_at,
    ).toBeNull();
  });

  it('refuses a reused challenge and audits it', async () => {
    const h = await faceHarness();
    const student = await enrolledStudent(h, 'alice');
    const { attendanceId, device } = await checkIn(h, student);
    const ch = await challenge(h, student, attendanceId);
    expect(
      (await submit(h, student, ch.json().challengeId, ['subject:alice', 'live:true'], device))
        .statusCode,
    ).toBe(200);
    const again = await submit(
      h,
      student,
      ch.json().challengeId,
      ['subject:alice', 'live:true'],
      device,
    );
    expect(again.statusCode).toBe(409);
    expect(again.json().error.code).toBe('CHALLENGE_USED');
    expect(await h.audit('FACE_CHECK_CHALLENGE_REUSED')).toHaveLength(1);
  });

  it('a challenge not completed in time is EXPIRED', async () => {
    const h = await faceHarness();
    const student = await enrolledStudent(h, 'alice');
    const { attendanceId, device } = await checkIn(h, student);
    const ch = await challenge(h, student, attendanceId);
    await h.db.pool.query(
      `UPDATE face_check_challenges SET expires_at = clock_timestamp() - interval '1 second' WHERE id = $1`,
      [ch.json().challengeId],
    );
    const res = await submit(
      h,
      student,
      ch.json().challengeId,
      ['subject:alice', 'live:true'],
      device,
    );
    expect(res.json().outcome).toBe('EXPIRED');
  });

  it('stops issuing challenges once the attempts cap is reached', async () => {
    const h = await faceHarness({ FACE_MAX_ATTEMPTS: 2 });
    const student = await enrolledStudent(h, 'alice');
    const { attendanceId, device } = await checkIn(h, student);
    for (let i = 0; i < 2; i++) {
      const ch = await challenge(h, student, attendanceId);
      expect(ch.statusCode).toBe(200);
      expect(
        (
          await submit(h, student, ch.json().challengeId, ['subject:bob', 'live:true'], device)
        ).json().outcome,
      ).toBe('FAILED');
    }
    const blocked = await challenge(h, student, attendanceId);
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json().error.code).toBe('TOO_MANY_ATTEMPTS');
  });
});

describe('frames, privacy and the flag', () => {
  it('never stores or logs a frame from the check upload', async () => {
    const h = await faceHarness();
    const student = await enrolledStudent(h, 'alice');
    await runCheck(h, student, ['subject:alice', 'live:true', SENTINEL]);
    const inDb = (
      await h.db.pool.query<{ n: number }>(
        `SELECT (SELECT count(*) FROM audit_events WHERE summary::text LIKE '%' || $1 || '%')
              + (SELECT count(*) FROM face_check_challenges WHERE content::text LIKE '%' || $1 || '%') AS n`,
        [SENTINEL],
      )
    ).rows[0]!.n;
    expect(Number(inDb)).toBe(0);
    expect(h.t.logs()).not.toContain(SENTINEL);
  });

  it('a student sees their own checks; the lecturer roster shows no face outcome or score', async () => {
    const h = await faceHarness();
    const student = await enrolledStudent(h, 'alice');
    const { res, attendanceId } = await runCheck(h, student, ['subject:bob', 'live:true']); // FAILED
    expect(res.json().outcome).toBe('FAILED');

    // The student's own privacy view lists the check, in plain terms.
    const privacy = (await h.get('/me/privacy', student.cookie)).json();
    expect(privacy.faceChecks.some((f: { outcome: string }) => f.outcome === 'FAILED')).toBe(true);

    // The lecturer's attendance view carries nothing about the face check.
    const sessionId = (
      await h.db.pool.query('SELECT session_id FROM attendance_records WHERE id = $1', [
        attendanceId,
      ])
    ).rows[0]!.session_id;
    const roster = await h.get(`/courses/${h.courseId}/sessions/${sessionId}/attendance`);
    const text = roster.body.toLowerCase();
    for (const forbidden of ['face', 'liveness', 'match_score', 'failed']) {
      expect(text).not.toContain(forbidden);
    }
  });

  it('with the flag off, check-in is unchanged and no face check can be started', async () => {
    const h = await createHarness(); // flag stays off
    harnesses.push(h);
    const session = await h.openSession();
    const [student] = await h.checkInStudents(session, 1);
    const res = await h.scan(student!, await h.openSession(), randomUUID());
    const body = res.json();
    expect(body.faceCheck).toBeUndefined();
    expect(body.attendanceId).toBeUndefined();
    // Even with a real attendance id, the challenge route is absent for a non-pilot course.
    const attendanceId = (
      await h.db.pool.query('SELECT id FROM attendance_records WHERE student_id = $1 LIMIT 1', [
        student!.id,
      ])
    ).rows[0]!.id;
    expect((await challenge(h, student!, attendanceId)).statusCode).toBe(404);
  });
});

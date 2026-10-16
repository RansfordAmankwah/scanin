import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { mintToken, parseKeyring } from '../../src/qr/token.js';
import { TEST_CONFIG } from '../helpers/app.js';
import { createHarness, type Harness } from '../antiproxy/harness.js';
import type { BulkStudent } from '../helpers/students.js';

/**
 * Phase 4 edge cases that the pilot must get right. Several of the listed cases (challenge replay,
 * a device swap between scan and capture, an outage falling back to sampling, a flag-off course, and
 * no lecturer leak) are covered in face-check.test.ts and face-spot-check.test.ts; the two that need
 * their own scenario — a relayed code and a mid-term withdrawal — are here.
 */
let harnesses: Harness[] = [];
afterEach(async () => {
  await Promise.all(harnesses.map((h) => h.close()));
  harnesses = [];
});
const keyring = parseKeyring(TEST_CONFIG.QR_KEYS, TEST_CONFIG.QR_ACTIVE_KID);

async function faceHarness(): Promise<Harness> {
  const h = await createHarness();
  harnesses.push(h);
  await h.db.pool.query('UPDATE courses SET face_verification_enabled = true WHERE id = $1', [
    h.courseId,
  ]);
  return h;
}

async function enrolled(h: Harness, subject: string): Promise<BulkStudent> {
  const [s] = await h.checkInStudents(await h.openSession(), 1);
  const linkId = (
    await h.db.pool.query<{ id: string }>(
      'SELECT id FROM roster_links WHERE course_id = $1 AND student_id = $2',
      [h.courseId, s!.id],
    )
  ).rows[0]!.id;
  await h.post('/me/biometric-consent', {}, s!.cookie);
  const o = await h.post(
    `/courses/${h.courseId}/face-enrollments`,
    { linkId, idMethod: 'STUDENT_ID_CARD' },
    h.lecturer.cookie,
  );
  await h.post(
    `/me/face-enrollments/${o.json().sessionId}/complete`,
    { frames: [`subject:${subject}`, 'live:true'] },
    s!.cookie,
  );
  return s!;
}

describe('a relayed QR code', () => {
  it('is refused even in a face-enabled course, so no face check is ever reached', async () => {
    const h = await faceHarness();
    const student = await enrolled(h, 'alice');
    const session = await h.openSession();
    // A code relayed to the student long after it was shown (well past the ~30s acceptance window).
    const nowMs = Number(
      (
        await h.db.pool.query<{ ms: string }>(
          `SELECT floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint AS ms`,
        )
      ).rows[0]!.ms,
    );
    const stale = mintToken(keyring, session, nowMs - 60_000).token;
    const res = await h.post(
      '/checkins',
      { token: stale, clientAttemptId: randomUUID(), deviceId: randomUUID() },
      student.cookie,
    );
    expect(res.statusCode).toBe(410);
    expect(res.json().error.code).toBe('CODE_EXPIRED');
    expect(await h.count('SELECT 1 FROM face_check_challenges', [])).toBe(0);
  });
});

describe('withdrawing consent mid-term', () => {
  it('deletes the template and makes the student EXEMPT at the next session', async () => {
    const h = await faceHarness();
    const student = await enrolled(h, 'alice');

    // The student withdraws; the template is deleted.
    const w = await h.post('/me/biometric-consent/withdraw', {}, student.cookie);
    expect(w.json().templateDeleted).toBe(true);
    expect(
      await h.count('SELECT 1 FROM face_enrollments WHERE student_id = $1 AND deleted_at IS NULL', [
        student.id,
      ]),
    ).toBe(0);

    // Next session: they check in and the face check is EXEMPT (an in-person fallback), not an error.
    const session = await h.openSession();
    const scan = await h.scan(student, session, randomUUID());
    const ch = await h.post(
      '/me/face-checks/challenge',
      { attendanceId: scan.json().attendanceId },
      student.cookie,
    );
    expect(ch.json()).toEqual({ outcome: 'EXEMPT' });
  });
});

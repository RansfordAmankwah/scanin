import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import type { FaceVerifier } from '../../src/face/verifier.js';
import { createHarness, type Harness } from '../antiproxy/harness.js';
import type { BulkStudent } from '../helpers/students.js';

/**
 * Phase 1: biometric consent, supervised enrollment, withdrawal, and the student's own privacy view.
 * The non-negotiables are checked here: no raw frame is ever stored or logged, the lecturer sees
 * nothing of consent or sub-reasons, and a flag-off course behaves exactly as before.
 */
let harnesses: Harness[] = [];
afterEach(async () => {
  await Promise.all(harnesses.map((h) => h.close()));
  harnesses = [];
});

const FRAME_SENTINEL = 'FRAME-SENTINEL-' + '9f8e7d6c';
const frames = (subject: string, extra: string[] = []) => [
  `subject:${subject}`,
  'live:true',
  FRAME_SENTINEL,
  ...extra,
];

async function setup(opts: { faceOn?: boolean; faceVerifier?: FaceVerifier } = {}) {
  const h = await createHarness({}, opts.faceVerifier ? { faceVerifier: opts.faceVerifier } : {});
  harnesses.push(h);
  if (opts.faceOn ?? true)
    await h.db.pool.query('UPDATE courses SET face_verification_enabled = true WHERE id = $1', [
      h.courseId,
    ]);
  // A student who belongs to the course (a check-in creates the roster link).
  const session = await h.openSession();
  const [student] = await h.checkInStudents(session, 1);
  const link = (
    await h.db.pool.query<{ id: string }>(
      'SELECT id FROM roster_links WHERE course_id = $1 AND student_id = $2',
      [h.courseId, student!.id],
    )
  ).rows[0]!.id;
  return { h, student: student!, linkId: link };
}

const consent = (h: Harness, student: BulkStudent) =>
  h.post('/me/biometric-consent', {}, student.cookie);
const openEnrollment = (h: Harness, linkId: string, idMethod = 'STUDENT_ID_CARD') =>
  h.post(`/courses/${h.courseId}/face-enrollments`, { linkId, idMethod }, h.lecturer.cookie);
const complete = (h: Harness, student: BulkStudent, sessionId: string, subject = 'alice') =>
  h.post(`/me/face-enrollments/${sessionId}/complete`, { frames: frames(subject) }, student.cookie);

/** The full happy path, reused by several tests. */
async function enroll(h: Harness, student: BulkStudent, linkId: string, subject = 'alice') {
  expect((await consent(h, student)).statusCode).toBe(200);
  const opened = await openEnrollment(h, linkId);
  expect(opened.statusCode).toBe(201);
  const done = await complete(h, student, opened.json().sessionId, subject);
  expect(done.statusCode).toBe(201);
  return opened.json().sessionId as string;
}

describe('consent and supervised enrollment', () => {
  it('lets a consenting student complete a lecturer-supervised enrollment, storing only a sealed template', async () => {
    const { h, student, linkId } = await setup();
    await enroll(h, student, linkId, 'alice');

    const row = (
      await h.db.pool.query<{
        template_cipher: Buffer;
        model_version: string;
        id_method: string;
        supervised_by: string;
        deletion_state: string | null;
      }>(
        `SELECT template_cipher, model_version, id_method::text AS id_method, supervised_by, deletion_state::text AS deletion_state
           FROM face_enrollments WHERE student_id = $1`,
        [student.id],
      )
    ).rows[0]!;
    expect(row.model_version).toBe('fake-1.0');
    expect(row.id_method).toBe('STUDENT_ID_CARD');
    expect(row.supervised_by).toBe(h.lecturer.id);
    expect(row.deletion_state).toBeNull();
    // The sealed template is not the plaintext reference.
    expect(row.template_cipher.toString('utf8')).not.toContain('fake-template');

    // Audit records consent and enrollment, as SECURITY events with no course-scoped leak of either.
    expect(await h.audit('FACE_CONSENT_GRANTED')).toHaveLength(1);
    const enrolledAudit = await h.audit('FACE_ENROLLED');
    expect(enrolledAudit).toHaveLength(1);
    expect(enrolledAudit[0]!.summary).not.toHaveProperty('frames');
  });

  it('never stores or logs a raw frame: not in the database, not in the audit trail, not in the logs', async () => {
    const { h, student, linkId } = await setup();
    await enroll(h, student, linkId);

    // Not in any text/jsonb column of the face or audit tables.
    const hits = (
      await h.db.pool.query<{ n: number }>(
        `SELECT
           (SELECT count(*) FROM audit_events WHERE summary::text LIKE '%' || $1 || '%')
         + (SELECT count(*) FROM face_enrollments WHERE encode(template_cipher, 'escape') LIKE '%' || $1 || '%')
           AS n`,
        [FRAME_SENTINEL],
      )
    ).rows[0]!.n;
    expect(Number(hits)).toBe(0);
    // Not in the request logs (Fastify does not log bodies, and nothing echoes them).
    expect(h.t.logs()).not.toContain(FRAME_SENTINEL);
  });

  it('refuses enrollment without consent, and when consent is to an older notice version', async () => {
    const { h, student, linkId } = await setup();
    // No consent yet.
    const opened = await openEnrollment(h, linkId);
    const blocked = await complete(h, student, opened.json().sessionId);
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json().error.code).toBe('CONSENT_REQUIRED');
    expect(
      await h.count('SELECT 1 FROM face_enrollments WHERE student_id = $1', [student.id]),
    ).toBe(0);

    // Consent recorded under an older notice version does not satisfy the current one.
    await h.db.pool.query(
      `INSERT INTO biometric_consent_events (student_id, event_no, kind, notice_version)
       VALUES ($1, 1, 'GRANTED', 'ancient-notice')`,
      [student.id],
    );
    const opened2 = await openEnrollment(h, linkId);
    const stale = await complete(h, student, opened2.json().sessionId);
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error.code).toBe('CONSENT_REQUIRED');
  });

  it('only the named student, with an open unexpired session, can complete it', async () => {
    const { h, student, linkId } = await setup();
    expect((await consent(h, student)).statusCode).toBe(200);
    const opened = await openEnrollment(h, linkId);
    const sessionId = opened.json().sessionId;

    // Another student cannot complete someone else's session.
    const [intruder] = await h.checkInStudents(await h.openSession(), 1);
    expect((await consent(h, intruder!)).statusCode).toBe(200);
    const stolen = await h.post(
      `/me/face-enrollments/${sessionId}/complete`,
      { frames: frames('mallory') },
      intruder!.cookie,
    );
    expect(stolen.statusCode).toBe(404);

    // An expired session cannot be completed.
    await h.db.pool.query(
      `UPDATE face_enrollment_sessions SET expires_at = clock_timestamp() - interval '1 second' WHERE id = $1`,
      [sessionId],
    );
    const late = await complete(h, student, sessionId);
    expect(late.statusCode).toBe(404);
  });

  it('is idempotent on consent: agreeing twice records one event, and the second time changes nothing', async () => {
    const { h, student } = await setup();
    expect((await consent(h, student)).statusCode).toBe(200);
    expect((await consent(h, student)).statusCode).toBe(200);
    expect(
      await h.count('SELECT 1 FROM biometric_consent_events WHERE student_id = $1', [student.id]),
    ).toBe(1);
  });
});

describe('the per-course feature flag', () => {
  it('with the flag off, the enrollment route is absent (404) and nothing else changes', async () => {
    const { h, linkId } = await setup({ faceOn: false });
    const opened = await openEnrollment(h, linkId);
    expect(opened.statusCode).toBe(404);
    // A normal lecturer endpoint on the same course still works, proving only face is gated.
    expect((await h.get(`/courses/${h.courseId}/sessions`, h.lecturer.cookie)).statusCode).toBe(
      200,
    );
    expect(await h.count('SELECT 1 FROM face_enrollment_sessions', [])).toBe(0);
  });
});

describe('the lecturer sees nothing of consent or sub-reasons', () => {
  it('the open-enrollment response carries only a session id and expiry', async () => {
    const { h, student, linkId } = await setup();
    expect((await consent(h, student)).statusCode).toBe(200);
    const body = (await openEnrollment(h, linkId)).json();
    expect(Object.keys(body).sort()).toEqual(['expiresAt', 'sessionId']);
    const text = JSON.stringify(body).toLowerCase();
    for (const forbidden of ['consent', 'notice', 'withdrawn', 'granted', 'frame', 'template']) {
      expect(text).not.toContain(forbidden);
    }
  });

  it('consent and enrollment audit events are SECURITY and not tied to a course', async () => {
    const { h, student, linkId } = await setup();
    await enroll(h, student, linkId);
    const rows = (
      await h.db.pool.query<{ class: string; course_id: string | null; action: string }>(
        `SELECT class::text AS class, course_id, action FROM audit_events
          WHERE action IN ('FACE_CONSENT_GRANTED', 'FACE_ENROLLED')`,
      )
    ).rows;
    expect(rows.length).toBe(2);
    for (const r of rows) {
      expect(r.class).toBe('SECURITY');
      expect(r.course_id).toBeNull(); // never appears in a course-scoped (lecturer-visible) query
    }
  });
});

describe('withdrawal and template deletion', () => {
  it('withdrawing deletes the vendor template, confirms it, and frees the student to enroll again', async () => {
    const { h, student, linkId } = await setup();
    await enroll(h, student, linkId, 'alice');

    const res = await h.post('/me/biometric-consent/withdraw', {}, student.cookie);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ templateDeleted: true });
    expect(res.json().consent.state).toBe('WITHDRAWN');

    const enr = (
      await h.db.pool.query<{ deletion_state: string }>(
        `SELECT deletion_state::text AS deletion_state FROM face_enrollments WHERE student_id = $1`,
        [student.id],
      )
    ).rows[0]!;
    expect(enr.deletion_state).toBe('CONFIRMED');
    expect(await h.audit('FACE_TEMPLATE_DELETED')).toHaveLength(1);
    expect(await h.audit('FACE_CONSENT_WITHDRAWN')).toHaveLength(1);
  });

  it('a failed vendor deletion is never reported as done; a retry confirms it later', async () => {
    let failDeletes = true;
    const flaky: FaceVerifier = {
      modelVersion: 'flaky-1.0',
      async enroll() {
        return { templateRef: 'flaky-template:bob' };
      },
      async verify() {
        return { liveness: 'PASS', matchScore: 1, modelVersion: 'flaky-1.0' };
      },
      async deleteTemplate() {
        if (failDeletes)
          throw new (await import('../../src/face/verifier.js')).FaceVerifierError(
            'UNAVAILABLE',
            'down',
          );
      },
    };
    const { h, student, linkId } = await setup({ faceVerifier: flaky });
    await enroll(h, student, linkId);

    const res = await h.post('/me/biometric-consent/withdraw', {}, student.cookie);
    expect(res.json().templateDeleted).toBe(false); // honestly not done
    expect(
      (
        await h.db.pool.query('SELECT deletion_state FROM face_enrollments WHERE student_id = $1', [
          student.id,
        ])
      ).rows[0]!.deletion_state,
    ).toBe('PENDING');
    expect(await h.audit('FACE_TEMPLATE_DELETED')).toHaveLength(0);

    // The vendor recovers; loading the privacy page retries the pending deletion and confirms it.
    failDeletes = false;
    expect((await h.get('/me/privacy', student.cookie)).statusCode).toBe(200);
    expect(
      (
        await h.db.pool.query('SELECT deletion_state FROM face_enrollments WHERE student_id = $1', [
          student.id,
        ])
      ).rows[0]!.deletion_state,
    ).toBe('CONFIRMED');
    expect(await h.audit('FACE_TEMPLATE_DELETED')).toHaveLength(1);
  });
});

describe("the student's own privacy view and export", () => {
  it('shows the student their consent, enrollment and (empty) check history, and exports their own data', async () => {
    const { h, student, linkId } = await setup();
    await enroll(h, student, linkId);

    const privacy = (await h.get('/me/privacy', student.cookie)).json();
    expect(privacy.consent).toMatchObject({
      state: 'GRANTED',
      currentNoticeVersion: 'test-notice-v1',
    });
    expect(privacy.enrollment).toMatchObject({ idMethod: 'STUDENT_ID_CARD' });
    expect(privacy.faceChecks).toEqual([]);
    expect(privacy.inPersonReasons).toEqual([]);

    const exported = await h.get('/me/privacy/export', student.cookie);
    expect(exported.headers['content-disposition']).toContain('attachment');
    const data = exported.json();
    expect(data.consentHistory).toHaveLength(1);
    expect(data.consent.state).toBe('GRANTED');
    // The export is the student's own data; it carries no biometric template.
    expect(JSON.stringify(data)).not.toContain('template');
  });

  it('a lecturer cannot open enrollment for a student who is not in the course', async () => {
    const { h } = await setup();
    // A link id from nowhere: the lecturer open route rejects it with a 404.
    const res = await openEnrollment(h, randomUUID());
    expect(res.statusCode).toBe(404);
  });
});

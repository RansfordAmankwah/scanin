import { randomBytes, randomInt } from 'node:crypto';
import type pg from 'pg';
import { writeAudit } from '../audit.js';
import { withTransaction } from '../db/pool.js';
import { openTemplate, sealTemplate } from './crypto.js';
import { FaceVerifierError, type FaceVerifier } from './verifier.js';

/**
 * Face-verification pilot: biometric consent, supervised enrollment, withdrawal, and the student's
 * own privacy view and export. No raw frame is ever persisted or logged; only an encrypted template
 * reference is stored, and it is deleted from the vendor on withdrawal.
 */
export class FaceError extends Error {
  constructor(
    readonly status: 400 | 403 | 404 | 409 | 503,
    readonly code: string,
    message: string,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'FaceError';
  }
}

const UTC = `'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'`;
type Pool = pg.Pool;

export interface FaceConfig {
  verifier: FaceVerifier;
  templateKey: string | undefined;
  noticeVersion: string;
  enrollmentTtlSeconds: number;
  challengeTtlSeconds: number;
  matchThreshold: number;
  maxAttempts: number;
}

const ADVISORY_LOCK = 'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))';

// ------------------------------------------------------------------------------------------------
// Consent (global to the student)
// ------------------------------------------------------------------------------------------------
export interface ConsentState {
  state: 'GRANTED' | 'WITHDRAWN' | 'NONE';
  noticeVersion: string | null;
  at: string | null;
}

export async function currentConsent(
  db: pg.Pool | pg.PoolClient,
  studentId: string,
): Promise<ConsentState> {
  const { rows } = await db.query<{
    kind: 'GRANTED' | 'WITHDRAWN';
    notice_version: string;
    at: string;
  }>(
    `SELECT kind::text AS kind, notice_version, to_char(at AT TIME ZONE 'UTC', ${UTC}) AS at
       FROM biometric_consent_events WHERE student_id = $1 ORDER BY event_no DESC LIMIT 1`,
    [studentId],
  );
  const r = rows[0];
  if (!r) return { state: 'NONE', noticeVersion: null, at: null };
  return { state: r.kind, noticeVersion: r.notice_version, at: r.at };
}

/** Records the student's consent to biometric processing under the current notice version. */
export async function grantConsent(
  pool: Pool,
  cfg: FaceConfig,
  input: { studentId: string; ipHash?: Buffer | null },
): Promise<ConsentState> {
  return withTransaction(pool, async (c) => {
    await c.query(ADVISORY_LOCK, [`faceconsent:${input.studentId}`]);
    const current = await currentConsent(c, input.studentId);
    if (current.state === 'GRANTED' && current.noticeVersion === cfg.noticeVersion) return current;

    const next = await c.query<{ event_no: number }>(
      `SELECT COALESCE(max(event_no), 0) + 1 AS event_no FROM biometric_consent_events WHERE student_id = $1`,
      [input.studentId],
    );
    await c.query(
      `INSERT INTO biometric_consent_events (student_id, event_no, kind, notice_version)
       VALUES ($1, $2, 'GRANTED', $3)`,
      [input.studentId, next.rows[0]!.event_no, cfg.noticeVersion],
    );
    await writeAudit(c, {
      class: 'SECURITY',
      actorType: 'STUDENT',
      actorUserId: input.studentId,
      action: 'FACE_CONSENT_GRANTED',
      ipHash: input.ipHash ?? null,
      summary: { noticeVersion: cfg.noticeVersion },
    });
    return currentConsent(c, input.studentId);
  });
}

// ------------------------------------------------------------------------------------------------
// Template deletion (shared by withdrawal and the retry job). Never reports success unless the
// vendor actually deleted the template.
// ------------------------------------------------------------------------------------------------
async function confirmDeletion(
  pool: Pool,
  cfg: FaceConfig,
  enrollmentId: string,
): Promise<boolean> {
  if (!cfg.templateKey) return false;
  const { rows } = await pool.query<{
    student_id: string;
    template_cipher: Buffer;
    template_nonce: Buffer;
    template_tag: Buffer;
  }>(
    `SELECT student_id, template_cipher, template_nonce, template_tag
       FROM face_enrollments WHERE id = $1 AND deletion_state = 'PENDING'`,
    [enrollmentId],
  );
  const e = rows[0];
  if (!e) return false;
  const ref = openTemplate(cfg.templateKey, {
    cipher: e.template_cipher,
    nonce: e.template_nonce,
    tag: e.template_tag,
  });
  try {
    await cfg.verifier.deleteTemplate(ref);
  } catch (err) {
    if (err instanceof FaceVerifierError) return false; // leave PENDING; a retry will try again
    throw err;
  }
  await withTransaction(pool, async (c) => {
    const moved = await c.query(
      `UPDATE face_enrollments SET deletion_state = 'CONFIRMED'
         WHERE id = $1 AND deletion_state = 'PENDING'`,
      [enrollmentId],
    );
    if ((moved.rowCount ?? 0) === 1) {
      await writeAudit(c, {
        class: 'SECURITY',
        actorType: 'SYSTEM',
        actorUserId: e.student_id,
        action: 'FACE_TEMPLATE_DELETED',
        entityType: 'face_enrollment',
        entityId: enrollmentId,
      });
    }
  });
  return true;
}

/** Retries every enrollment whose template deletion has not yet been confirmed. */
export async function retryPendingFaceDeletions(pool: Pool, cfg: FaceConfig): Promise<number> {
  const { rows } = await pool.query<{ id: string }>(
    `SELECT id FROM face_enrollments WHERE deletion_state = 'PENDING' ORDER BY deleted_at`,
  );
  let confirmed = 0;
  for (const r of rows) if (await confirmDeletion(pool, cfg, r.id)) confirmed += 1;
  return confirmed;
}

/** Withdraws consent and deletes the student's template. Deletion is confirmed only on vendor success. */
export async function withdrawConsent(
  pool: Pool,
  cfg: FaceConfig,
  input: { studentId: string; ipHash?: Buffer | null },
): Promise<{ consent: ConsentState; deletionConfirmed: boolean; hadEnrollment: boolean }> {
  const { enrollmentId } = await withTransaction(pool, async (c) => {
    await c.query(ADVISORY_LOCK, [`faceconsent:${input.studentId}`]);
    const next = await c.query<{ event_no: number }>(
      `SELECT COALESCE(max(event_no), 0) + 1 AS event_no FROM biometric_consent_events WHERE student_id = $1`,
      [input.studentId],
    );
    await c.query(
      `INSERT INTO biometric_consent_events (student_id, event_no, kind, notice_version)
       VALUES ($1, $2, 'WITHDRAWN', $3)`,
      [input.studentId, next.rows[0]!.event_no, cfg.noticeVersion],
    );
    // Any pending enrollment session is abandoned; it can no longer be completed without consent.
    await c.query(
      `UPDATE face_enrollment_sessions SET state = 'CANCELLED' WHERE student_id = $1 AND state = 'PENDING'`,
      [input.studentId],
    );
    const active = await c.query<{ id: string }>(
      `UPDATE face_enrollments SET deleted_at = clock_timestamp(), deletion_state = 'PENDING'
         WHERE student_id = $1 AND deleted_at IS NULL RETURNING id`,
      [input.studentId],
    );
    await writeAudit(c, {
      class: 'SECURITY',
      actorType: 'STUDENT',
      actorUserId: input.studentId,
      action: 'FACE_CONSENT_WITHDRAWN',
      ipHash: input.ipHash ?? null,
      summary: { hadEnrollment: active.rows.length > 0 },
    });
    return { enrollmentId: active.rows[0]?.id ?? null };
  });

  let deletionConfirmed = false;
  if (enrollmentId) deletionConfirmed = await confirmDeletion(pool, cfg, enrollmentId);
  return {
    consent: await currentConsent(pool, input.studentId),
    deletionConfirmed,
    hadEnrollment: enrollmentId !== null,
  };
}

// ------------------------------------------------------------------------------------------------
// Supervised enrollment
// ------------------------------------------------------------------------------------------------
/** A lecturer, having checked the student's ID, opens a short-lived capture session for them. */
export async function openEnrollmentSession(
  pool: Pool,
  cfg: FaceConfig,
  input: {
    courseId: string;
    lecturerId: string;
    studentId: string;
    idMethod: 'STUDENT_ID_CARD' | 'OTHER_OFFICIAL_ID';
  },
): Promise<{ sessionId: string; expiresAt: string }> {
  return withTransaction(pool, async (c) => {
    // The named student must belong to this course (an association exists). Identical 404 otherwise.
    const member = await c.query(
      `SELECT 1 FROM roster_links WHERE course_id = $1 AND student_id = $2`,
      [input.courseId, input.studentId],
    );
    if (member.rowCount === 0)
      throw new FaceError(404, 'NOT_FOUND', 'No such student in this course.');

    const already = await c.query(
      `SELECT 1 FROM face_enrollments WHERE student_id = $1 AND deleted_at IS NULL`,
      [input.studentId],
    );
    if ((already.rowCount ?? 0) > 0)
      throw new FaceError(409, 'ALREADY_ENROLLED', 'This student already has a face enrollment.');

    // One pending session per student; replace any earlier one so the latest supervisor wins.
    await c.query(
      `UPDATE face_enrollment_sessions SET state = 'CANCELLED' WHERE student_id = $1 AND state = 'PENDING'`,
      [input.studentId],
    );
    const { rows } = await c.query<{ id: string; expires_at: string }>(
      `INSERT INTO face_enrollment_sessions (course_id, student_id, created_by, id_method, expires_at)
       VALUES ($1, $2, $3, $4, clock_timestamp() + make_interval(secs => $5))
       RETURNING id, to_char(expires_at AT TIME ZONE 'UTC', ${UTC}) AS expires_at`,
      [input.courseId, input.studentId, input.lecturerId, input.idMethod, cfg.enrollmentTtlSeconds],
    );
    await writeAudit(c, {
      class: 'SECURITY',
      actorType: 'LECTURER',
      actorUserId: input.lecturerId,
      action: 'FACE_ENROLLMENT_OPENED',
      courseId: input.courseId,
      entityType: 'face_enrollment_session',
      entityId: rows[0]!.id,
      summary: { idMethod: input.idMethod },
    });
    return { sessionId: rows[0]!.id, expiresAt: rows[0]!.expires_at };
  });
}

/** The student completes capture on their own device. Frames are used once, in memory, never stored. */
export async function completeEnrollment(
  pool: Pool,
  cfg: FaceConfig,
  input: { studentId: string; sessionId: string; frames: string[] },
): Promise<{ enrolledAt: string }> {
  if (!cfg.templateKey)
    throw new FaceError(503, 'NOT_CONFIGURED', 'Face enrollment is not configured on this server.');

  // Consent (current notice version) is required before anything is captured.
  const consent = await currentConsent(pool, input.studentId);
  if (consent.state !== 'GRANTED' || consent.noticeVersion !== cfg.noticeVersion)
    throw new FaceError(409, 'CONSENT_REQUIRED', 'Agree to the current privacy notice first.');

  // The session must be the student's own, pending, and unexpired.
  const found = await pool.query<{ id: string; id_method: string; created_by: string }>(
    `SELECT id, id_method::text AS id_method, created_by FROM face_enrollment_sessions
      WHERE id = $1 AND student_id = $2 AND state = 'PENDING' AND expires_at > clock_timestamp()`,
    [input.sessionId, input.studentId],
  );
  const session = found.rows[0];
  if (!session) throw new FaceError(404, 'NOT_FOUND', 'No open enrollment session.');

  // The verifier call is a network boundary, done before the transaction. Frames never leave here.
  let templateRef: string;
  try {
    ({ templateRef } = await cfg.verifier.enroll(input.frames));
  } catch (err) {
    if (err instanceof FaceVerifierError)
      throw new FaceError(503, 'VERIFIER_UNAVAILABLE', 'Could not enroll just now. Try again.');
    throw err;
  }
  const sealed = sealTemplate(cfg.templateKey, templateRef);

  return withTransaction(pool, async (c) => {
    // Re-check the session under lock, and that no active enrollment appeared meanwhile.
    const locked = await c.query(
      `SELECT 1 FROM face_enrollment_sessions WHERE id = $1 AND state = 'PENDING' FOR UPDATE`,
      [input.sessionId],
    );
    if (locked.rowCount === 0)
      throw new FaceError(409, 'ALREADY_USED', 'This session was already used.');
    const active = await c.query(
      `SELECT 1 FROM face_enrollments WHERE student_id = $1 AND deleted_at IS NULL`,
      [input.studentId],
    );
    if ((active.rowCount ?? 0) > 0)
      throw new FaceError(409, 'ALREADY_ENROLLED', 'You already have a face enrollment.');

    const enrolled = await c.query<{ id: string; created_at: string }>(
      `INSERT INTO face_enrollments
         (student_id, template_cipher, template_nonce, template_tag, model_version, supervised_by, id_method)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id, to_char(created_at AT TIME ZONE 'UTC', ${UTC}) AS created_at`,
      [
        input.studentId,
        sealed.cipher,
        sealed.nonce,
        sealed.tag,
        cfg.verifier.modelVersion,
        session.created_by,
        session.id_method,
      ],
    );
    await c.query(
      `UPDATE face_enrollment_sessions SET state = 'COMPLETED', completed_at = clock_timestamp(), enrollment_id = $2
         WHERE id = $1`,
      [input.sessionId, enrolled.rows[0]!.id],
    );
    await writeAudit(c, {
      class: 'SECURITY',
      actorType: 'STUDENT',
      actorUserId: input.studentId,
      action: 'FACE_ENROLLED',
      entityType: 'face_enrollment',
      entityId: enrolled.rows[0]!.id,
      summary: {
        idMethod: session.id_method,
        supervisedBy: session.created_by,
        modelVersion: cfg.verifier.modelVersion,
      },
    });
    return { enrolledAt: enrolled.rows[0]!.created_at };
  });
}

// ------------------------------------------------------------------------------------------------
// The student's own privacy view and export
// ------------------------------------------------------------------------------------------------
export async function privacyFor(pool: Pool, cfg: FaceConfig, studentId: string) {
  const consent = await currentConsent(pool, studentId);
  const enrollment = (
    await pool.query<{
      enrolled_at: string;
      deletion_state: string | null;
      id_method: string;
      supervised_by: string;
    }>(
      `SELECT to_char(created_at AT TIME ZONE 'UTC', ${UTC}) AS enrolled_at,
              deletion_state::text AS deletion_state, id_method::text AS id_method, supervised_by
         FROM face_enrollments WHERE student_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [studentId],
    )
  ).rows[0];
  const pending = (
    await pool.query<{ id: string; code: string; title: string; expires_at: string }>(
      `SELECT s.id, co.code, co.title, to_char(s.expires_at AT TIME ZONE 'UTC', ${UTC}) AS expires_at
         FROM face_enrollment_sessions s JOIN courses co ON co.id = s.course_id
        WHERE s.student_id = $1 AND s.state = 'PENDING' AND s.expires_at > clock_timestamp()
        ORDER BY s.created_at DESC LIMIT 1`,
      [studentId],
    )
  ).rows[0];

  return {
    consent: {
      state: consent.state,
      noticeVersion: consent.noticeVersion,
      at: consent.at,
      currentNoticeVersion: cfg.noticeVersion,
    },
    enrollment:
      enrollment && !enrollment.deletion_state
        ? {
            enrolledAt: enrollment.enrolled_at,
            idMethod: enrollment.id_method,
          }
        : null,
    // Set while a deletion is still being confirmed with the vendor.
    deletionPending: enrollment?.deletion_state === 'PENDING',
    pendingEnrollment: pending
      ? {
          sessionId: pending.id,
          courseCode: pending.code,
          courseTitle: pending.title,
          expiresAt: pending.expires_at,
        }
      : null,
    // The student sees their own checks and outcomes, in plain terms (lecturers never see these).
    faceChecks: await studentFaceChecks(pool, studentId),
    // The occasions they were put on the in-person list because a face check could not confirm them.
    inPersonReasons: await studentInPersonReasons(pool, studentId),
  };
}

/** One row per face check the student has had, newest first: outcome, course and session. */
async function studentFaceChecks(pool: Pool, studentId: string) {
  const { rows } = await pool.query<{
    outcome: FaceCheckOutcome;
    attempt_number: number;
    at: string;
    code: string;
    session_title: string;
  }>(
    `SELECT e.outcome::text AS outcome, e.attempt_number,
            to_char(e.at AT TIME ZONE 'UTC', ${UTC}) AS at, co.code, s.title AS session_title
       FROM attendance_face_check_events e
       JOIN courses co ON co.id = e.course_id
       JOIN class_sessions s ON s.id = e.session_id
      WHERE e.student_id = $1
      ORDER BY e.at DESC LIMIT 100`,
    [studentId],
  );
  return rows.map((r) => ({
    outcome: r.outcome,
    attempt: r.attempt_number,
    at: r.at,
    courseCode: r.code,
    sessionTitle: r.session_title,
  }));
}

// ------------------------------------------------------------------------------------------------
// Face checks: a challenge issued after check-in, then one capture attempt against it. A face check
// never changes attendance; it only records an outcome that a lecturer can act on in person.
// ------------------------------------------------------------------------------------------------
export type FaceCheckOutcome =
  'VERIFIED' | 'FAILED' | 'LIVENESS_REJECTED' | 'EXEMPT' | 'EXPIRED' | 'UNAVAILABLE';

const MOVES = ['turn left', 'turn right', 'look up', 'look down', 'blink', 'smile'] as const;
/** A short server-chosen head-movement sequence; the content a capture must satisfy. */
function newChallengeContent(): { moves: string[]; nonce: string } {
  const moves: string[] = [];
  for (let i = 0; i < 3; i++) moves.push(MOVES[randomInt(MOVES.length)]!);
  return { moves, nonce: randomBytes(8).toString('hex') };
}

async function latestFaceOutcome(
  db: pg.Pool | pg.PoolClient,
  attendanceId: string,
): Promise<{ outcome: FaceCheckOutcome; attempts: number } | null> {
  const { rows } = await db.query<{ outcome: FaceCheckOutcome; attempts: number }>(
    `SELECT outcome::text AS outcome,
            (SELECT count(*)::int FROM attendance_face_check_events WHERE attendance_id = $1) AS attempts
       FROM attendance_face_check_events WHERE attendance_id = $1
      ORDER BY attempt_number DESC LIMIT 1`,
    [attendanceId],
  );
  return rows[0] ?? null;
}

async function recordFaceEvent(
  c: pg.PoolClient,
  cfg: FaceConfig,
  e: {
    attendanceId: string;
    courseId: string;
    sessionId: string;
    studentId: string;
    challengeId: string | null;
    attemptNumber: number;
    outcome: FaceCheckOutcome;
    liveness?: 'PASS' | 'FAIL' | null;
    matchScore?: number | null;
  },
): Promise<void> {
  const { rows } = await c.query<{ id: string }>(
    `INSERT INTO attendance_face_check_events
       (attendance_id, course_id, session_id, student_id, challenge_id, attempt_number, outcome, model_version)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
    [
      e.attendanceId,
      e.courseId,
      e.sessionId,
      e.studentId,
      e.challengeId,
      e.attemptNumber,
      e.outcome,
      cfg.verifier.modelVersion,
    ],
  );
  if (e.liveness != null || e.matchScore != null) {
    await c.query(
      `INSERT INTO face_check_details (event_id, liveness, match_score) VALUES ($1, $2, $3)`,
      [rows[0]!.id, e.liveness ?? null, e.matchScore ?? null],
    );
  }
  await writeAudit(c, {
    class: 'SECURITY',
    actorType: 'STUDENT',
    actorUserId: e.studentId,
    action: 'FACE_CHECK_RECORDED',
    entityType: 'attendance',
    entityId: e.attendanceId,
    // Outcome only: the score and liveness detail are not kept in the long-lived audit trail.
    summary: { outcome: e.outcome, attempt: e.attemptNumber },
  });
}

/** Issues a single-use challenge for the student's attendance, or records EXEMPT if they cannot be checked. */
export async function issueChallenge(
  pool: Pool,
  cfg: FaceConfig,
  input: { studentId: string; attendanceId: string },
): Promise<
  | { kind: 'CHALLENGE'; challengeId: string; content: unknown; expiresAt: string }
  | { kind: 'EXEMPT' }
> {
  const att = (
    await pool.query<{
      course_id: string;
      session_id: string;
      device_hash: Buffer | null;
      face_on: boolean;
    }>(
      `SELECT a.course_id, a.session_id, a.device_hash, co.face_verification_enabled AS face_on
         FROM attendance_records a JOIN courses co ON co.id = a.course_id
        WHERE a.id = $1 AND a.student_id = $2`,
      [input.attendanceId, input.studentId],
    )
  ).rows[0];
  // When off (or not the student's attendance) the route is indistinguishable from not existing.
  if (!att || !att.face_on) throw new FaceError(404, 'NOT_FOUND', 'Not found.');

  const latest = await latestFaceOutcome(pool, input.attendanceId);
  if (latest && (latest.outcome === 'VERIFIED' || latest.outcome === 'EXEMPT'))
    throw new FaceError(409, 'ALREADY_DONE', 'This check is already complete.');
  if (latest && latest.attempts >= cfg.maxAttempts)
    throw new FaceError(
      409,
      'TOO_MANY_ATTEMPTS',
      'No attempts remain; you will be checked in person.',
    );

  const consent = await currentConsent(pool, input.studentId);
  const enrolled =
    (
      await pool.query(
        'SELECT 1 FROM face_enrollments WHERE student_id = $1 AND deleted_at IS NULL',
        [input.studentId],
      )
    ).rowCount ?? 0;
  const eligible =
    consent.state === 'GRANTED' && consent.noticeVersion === cfg.noticeVersion && enrolled > 0;

  if (!eligible) {
    // No consent or no enrollment: the check is EXEMPT and falls back to an in-person check.
    await withTransaction(pool, async (c) => {
      const next = (latest?.attempts ?? 0) + 1;
      await recordFaceEvent(c, cfg, {
        attendanceId: input.attendanceId,
        courseId: att.course_id,
        sessionId: att.session_id,
        studentId: input.studentId,
        challengeId: null,
        attemptNumber: next,
        outcome: 'EXEMPT',
      });
    });
    return { kind: 'EXEMPT' };
  }

  const jti =
    (
      await pool.query<{ token_jti: string | null }>(
        `SELECT token_jti FROM scan_attempts WHERE attendance_id = $1 AND outcome = 'ACCEPTED' LIMIT 1`,
        [input.attendanceId],
      )
    ).rows[0]?.token_jti ?? null;
  const content = newChallengeContent();
  const { rows } = await pool.query<{ id: string; expires_at: string }>(
    `INSERT INTO face_check_challenges
       (attendance_id, course_id, session_id, student_id, device_hash, token_jti, content, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, clock_timestamp() + make_interval(secs => $8))
     RETURNING id, to_char(expires_at AT TIME ZONE 'UTC', ${UTC}) AS expires_at`,
    [
      input.attendanceId,
      att.course_id,
      att.session_id,
      input.studentId,
      att.device_hash,
      jti,
      JSON.stringify(content),
      cfg.challengeTtlSeconds,
    ],
  );
  return { kind: 'CHALLENGE', challengeId: rows[0]!.id, content, expiresAt: rows[0]!.expires_at };
}

async function abuseAudit(
  pool: Pool,
  studentId: string,
  action: string,
  attendanceId: string | null,
): Promise<void> {
  await writeAudit(pool, {
    class: 'SECURITY',
    actorType: 'STUDENT',
    actorUserId: studentId,
    action,
    outcome: 'DENIED',
    entityType: attendanceId ? 'attendance' : null,
    entityId: attendanceId,
  });
}

/** Records one attempt against a challenge. Frames are used once, in memory, never stored or logged. */
export async function submitFaceCheck(
  pool: Pool,
  cfg: FaceConfig,
  input: { studentId: string; challengeId: string; deviceHash: Buffer; frames: string[] },
): Promise<{ outcome: FaceCheckOutcome; attemptsLeft: number }> {
  const ch = (
    await pool.query<{
      attendance_id: string;
      course_id: string;
      session_id: string;
      student_id: string;
      device_hash: Buffer | null;
      content: unknown;
      used_at: string | null;
      expired: boolean;
    }>(
      `SELECT attendance_id, course_id, session_id, student_id, device_hash, content, used_at,
              (clock_timestamp() > expires_at) AS expired
         FROM face_check_challenges WHERE id = $1`,
      [input.challengeId],
    )
  ).rows[0];
  if (!ch || ch.student_id !== input.studentId) throw new FaceError(404, 'NOT_FOUND', 'Not found.');
  if (ch.used_at) {
    await abuseAudit(pool, input.studentId, 'FACE_CHECK_CHALLENGE_REUSED', ch.attendance_id);
    throw new FaceError(409, 'CHALLENGE_USED', 'That check was already submitted.');
  }
  // The capture must come from the same device that checked in.
  if (
    ch.device_hash &&
    !(ch.device_hash.length === input.deviceHash.length && ch.device_hash.equals(input.deviceHash))
  ) {
    await abuseAudit(pool, input.studentId, 'FACE_CHECK_WRONG_DEVICE', ch.attendance_id);
    throw new FaceError(403, 'WRONG_DEVICE', 'Use the device you checked in with.');
  }

  const attempts = (await latestFaceOutcome(pool, ch.attendance_id))?.attempts ?? 0;
  if (attempts >= cfg.maxAttempts)
    throw new FaceError(
      409,
      'TOO_MANY_ATTEMPTS',
      'No attempts remain; you will be checked in person.',
    );
  const attemptNumber = attempts + 1;

  const common = {
    attendanceId: ch.attendance_id,
    courseId: ch.course_id,
    sessionId: ch.session_id,
    studentId: input.studentId,
    challengeId: input.challengeId,
    attemptNumber,
  };
  const consume = () =>
    pool.query(`UPDATE face_check_challenges SET used_at = clock_timestamp() WHERE id = $1`, [
      input.challengeId,
    ]);

  // A challenge not completed in time is EXPIRED, evaluated lazily here on submit.
  if (ch.expired) {
    await withTransaction(pool, async (c) => {
      await recordFaceEvent(c, cfg, { ...common, outcome: 'EXPIRED' });
    });
    await consume();
    return { outcome: 'EXPIRED', attemptsLeft: Math.max(0, cfg.maxAttempts - attemptNumber) };
  }

  // The enrollment template may have been withdrawn between issue and submit.
  const enr = (
    await pool.query<{ template_cipher: Buffer; template_nonce: Buffer; template_tag: Buffer }>(
      `SELECT template_cipher, template_nonce, template_tag FROM face_enrollments
        WHERE student_id = $1 AND deleted_at IS NULL`,
      [input.studentId],
    )
  ).rows[0];
  if (!enr || !cfg.templateKey) {
    await withTransaction(pool, async (c) => {
      await recordFaceEvent(c, cfg, { ...common, outcome: 'EXEMPT' });
    });
    await consume();
    return { outcome: 'EXEMPT', attemptsLeft: 0 };
  }

  const templateRef = openTemplate(cfg.templateKey, {
    cipher: enr.template_cipher,
    nonce: enr.template_nonce,
    tag: enr.template_tag,
  });
  let outcome: FaceCheckOutcome;
  let liveness: 'PASS' | 'FAIL' | null = null;
  let matchScore: number | null = null;
  try {
    const r = await cfg.verifier.verify(templateRef, input.frames, JSON.stringify(ch.content));
    liveness = r.liveness;
    matchScore = r.matchScore;
    outcome =
      r.liveness === 'FAIL'
        ? 'LIVENESS_REJECTED'
        : r.matchScore >= cfg.matchThreshold
          ? 'VERIFIED'
          : 'FAILED';
  } catch (err) {
    if (err instanceof FaceVerifierError) outcome = 'UNAVAILABLE';
    else throw err;
  }

  await withTransaction(pool, async (c) => {
    await recordFaceEvent(c, cfg, { ...common, outcome, liveness, matchScore });
  });
  await consume();
  return {
    outcome,
    attemptsLeft: outcome === 'VERIFIED' ? 0 : Math.max(0, cfg.maxAttempts - attemptNumber),
  };
}

/**
 * Pilot metrics for a lecturer of a face-enabled course: totals only, no names and no per-student
 * sub-reasons. It answers "is the pilot working?" without exposing anyone's individual result.
 */
export async function pilotMetrics(pool: Pool, courseId: string) {
  const counts = (
    await pool.query<{
      attempted: number;
      verified: number;
      failed: number;
      liveness_rejected: number;
      unavailable: number;
      exempt: number;
    }>(
      `SELECT count(*) FILTER (WHERE outcome <> 'EXEMPT')::int AS attempted,
              count(*) FILTER (WHERE outcome = 'VERIFIED')::int AS verified,
              count(*) FILTER (WHERE outcome = 'FAILED')::int AS failed,
              count(*) FILTER (WHERE outcome = 'LIVENESS_REJECTED')::int AS liveness_rejected,
              count(*) FILTER (WHERE outcome = 'UNAVAILABLE')::int AS unavailable,
              count(DISTINCT attendance_id) FILTER (WHERE outcome = 'EXEMPT')::int AS exempt
         FROM attendance_face_check_events WHERE course_id = $1`,
      [courseId],
    )
  ).rows[0]!;
  const forced = (
    await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM spot_check_items WHERE course_id = $1 AND selection_reason = 'FACE_EXCEPTION'`,
      [courseId],
    )
  ).rows[0]!.n;
  const median = (
    await pool.query<{ median_seconds: number | null }>(
      `SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM (e.at - sa.received_at))) AS median_seconds
         FROM attendance_face_check_events e
         JOIN scan_attempts sa ON sa.attendance_id = e.attendance_id AND sa.outcome = 'ACCEPTED'
        WHERE e.course_id = $1 AND e.outcome = 'VERIFIED'`,
      [courseId],
    )
  ).rows[0]!.median_seconds;
  // In-person checks that found a face-verified student NOT present: a possible false accept.
  const notPresentAmongVerified = (
    await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM spot_check_items i
        WHERE i.course_id = $1 AND i.state = 'NOT_PRESENT'
          AND (SELECT e.outcome FROM attendance_face_check_events e
                WHERE e.attendance_id = i.attendance_id ORDER BY e.attempt_number DESC LIMIT 1) = 'VERIFIED'`,
      [courseId],
    )
  ).rows[0]!.n;

  return {
    attempted: counts.attempted,
    verified: counts.verified,
    failed: counts.failed,
    livenessRejected: counts.liveness_rejected,
    unavailable: counts.unavailable,
    exempt: counts.exempt,
    forcedListSize: forced,
    medianScanToVerifiedSeconds: median === null ? null : Math.round(Number(median) * 10) / 10,
    notPresentAmongFaceVerified: notPresentAmongVerified,
  };
}

/** Everything the student was asked to verify in person because a face check could not confirm them. */
async function studentInPersonReasons(pool: Pool, studentId: string) {
  const { rows } = await pool.query<{
    at: string;
    code: string;
    session_title: string;
    state: string;
  }>(
    `SELECT to_char(i.created_at AT TIME ZONE 'UTC', ${UTC}) AS at, co.code, s.title AS session_title,
            i.state::text AS state
       FROM spot_check_items i
       JOIN courses co ON co.id = i.course_id
       JOIN class_sessions s ON s.id = i.session_id
      WHERE i.student_id = $1 AND i.selection_reason = 'FACE_EXCEPTION'
      ORDER BY i.created_at DESC LIMIT 100`,
    [studentId],
  );
  return rows.map((r) => ({
    at: r.at,
    courseCode: r.code,
    sessionTitle: r.session_title,
    result: r.state,
  }));
}

/** The student's own face-related data, for them to download. Contains no biometric template. */
export async function exportFor(pool: Pool, cfg: FaceConfig, studentId: string) {
  const consentHistory = (
    await pool.query<{ kind: string; notice_version: string; at: string }>(
      `SELECT kind::text AS kind, notice_version, to_char(at AT TIME ZONE 'UTC', ${UTC}) AS at
         FROM biometric_consent_events WHERE student_id = $1 ORDER BY event_no`,
      [studentId],
    )
  ).rows;
  const privacy = await privacyFor(pool, cfg, studentId);
  return {
    exportedAt: new Date().toISOString(),
    consent: privacy.consent,
    consentHistory,
    enrollment: privacy.enrollment,
    faceChecks: privacy.faceChecks,
    inPersonReasons: privacy.inPersonReasons,
  };
}

-- Face-verification pilot: per-course feature flag, biometric consent, supervised enrollment.
--
-- Principles (same as the anti-proxy controls):
--   * Face checks are a REVIEW SIGNAL only. Nothing here creates, changes, invalidates or restores
--     attendance; the QR check-in path is untouched.
--   * NO raw image or frame is ever stored. Only an encrypted reference to a vendor template lives in
--     the database, and even that is AES-256-GCM ciphertext with a key held outside the database.
--   * Consent sub-reasons and the consent trail are the student's own data, never lecturer-facing.
--   * History is append-only; current state is the latest event.

-- Feature flag per course. Default OFF: with it off, a course behaves exactly as before.
ALTER TABLE courses ADD COLUMN face_verification_enabled boolean NOT NULL DEFAULT false;

-- ---------------------------------------------------------------------------------------------
-- Biometric consent. Global to the student (one face template per person, usable in any
-- flag-enabled course they attend), not per course. Append-only: the current state is the row with
-- the highest event_no for the student, exactly like session_headcounts.
-- ---------------------------------------------------------------------------------------------
CREATE TYPE biometric_consent_kind AS ENUM ('GRANTED', 'WITHDRAWN');

CREATE TABLE biometric_consent_events (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  student_id     uuid NOT NULL REFERENCES users (id),
  event_no       integer NOT NULL CHECK (event_no >= 1),
  kind           biometric_consent_kind NOT NULL,
  -- Which version of the privacy notice the student agreed to (or had agreed to when withdrawing).
  notice_version text NOT NULL CHECK (length(notice_version) BETWEEN 1 AND 100),
  at             timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT biometric_consent_student_event_key UNIQUE (student_id, event_no)
);
CREATE INDEX biometric_consent_student_idx ON biometric_consent_events (student_id, event_no DESC);

-- ---------------------------------------------------------------------------------------------
-- Face enrollment. One active template per student. The template reference returned by the verifier
-- is encrypted at rest; the ciphertext, nonce and auth tag are stored, never a frame or image.
-- Withdrawal sets deleted_at and deletion_state = PENDING, then CONFIRMED only once the vendor's
-- deleteTemplate has actually succeeded.
-- ---------------------------------------------------------------------------------------------
CREATE TYPE face_id_method AS ENUM ('STUDENT_ID_CARD', 'OTHER_OFFICIAL_ID');
CREATE TYPE face_deletion_state AS ENUM ('PENDING', 'CONFIRMED');

CREATE TABLE face_enrollments (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  student_id      uuid NOT NULL REFERENCES users (id),
  template_cipher bytea NOT NULL,
  template_nonce  bytea NOT NULL,
  template_tag    bytea NOT NULL,
  model_version   text NOT NULL,
  -- The lecturer who supervised the ID check. How they confirmed identity.
  supervised_by   uuid NOT NULL REFERENCES users (id),
  id_method       face_id_method NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT clock_timestamp(),
  deleted_at      timestamptz,
  deletion_state  face_deletion_state,
  -- deleted_at and deletion_state appear together or not at all.
  CONSTRAINT face_enrollments_deletion_pairing CHECK ((deleted_at IS NULL) = (deletion_state IS NULL))
);
-- At most one active (not-yet-deleted) enrollment per student.
CREATE UNIQUE INDEX face_enrollments_active_student_key
  ON face_enrollments (student_id) WHERE deleted_at IS NULL;
-- Pending deletions are retried by a job, so they need to be found quickly.
CREATE INDEX face_enrollments_pending_deletion_idx
  ON face_enrollments (deletion_state) WHERE deletion_state = 'PENDING';

-- ---------------------------------------------------------------------------------------------
-- Supervised enrollment sessions. A lecturer in a flag-enabled course, having checked the student's
-- ID, opens a short-lived session; the student then completes the capture on their own device.
-- ---------------------------------------------------------------------------------------------
CREATE TYPE face_enrollment_session_state AS ENUM ('PENDING', 'COMPLETED', 'CANCELLED');

CREATE TABLE face_enrollment_sessions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  course_id     uuid NOT NULL REFERENCES courses (id),
  student_id    uuid NOT NULL REFERENCES users (id),
  created_by    uuid NOT NULL REFERENCES users (id),
  id_method     face_id_method NOT NULL,
  state         face_enrollment_session_state NOT NULL DEFAULT 'PENDING',
  expires_at    timestamptz NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT clock_timestamp(),
  completed_at  timestamptz,
  enrollment_id uuid REFERENCES face_enrollments (id),
  CONSTRAINT face_enrollment_sessions_course_fk FOREIGN KEY (course_id) REFERENCES courses (id),
  CONSTRAINT face_enrollment_sessions_completion CHECK (
    (state = 'COMPLETED') = (completed_at IS NOT NULL AND enrollment_id IS NOT NULL)
  )
);
-- A student has at most one pending enrollment session at a time, across courses.
CREATE UNIQUE INDEX face_enrollment_sessions_pending_student_key
  ON face_enrollment_sessions (student_id) WHERE state = 'PENDING';
CREATE INDEX face_enrollment_sessions_course_idx ON face_enrollment_sessions (course_id);

-- ScanIn initial schema (M1).
-- Integrity rules live here on purpose: the application is not the only line of defence.
-- Privileges (append-only tables, column-level UPDATE) are applied by db/grants.sql, not here.

CREATE EXTENSION IF NOT EXISTS citext;

-- ---------------------------------------------------------------------------------------------
-- Enumerations
-- ---------------------------------------------------------------------------------------------
CREATE TYPE user_role AS ENUM ('LECTURER', 'STUDENT');
CREATE TYPE session_state AS ENUM ('NOT_STARTED', 'CHECK_IN_OPEN', 'CHECK_IN_CLOSED', 'ENDED');
CREATE TYPE close_reason AS ENUM ('DEADLINE', 'ENDED_BY_LECTURER');
CREATE TYPE attendance_status AS ENUM ('PRESENT', 'INVALIDATED');
CREATE TYPE attendance_source AS ENUM ('QR_SCAN', 'MANUAL');
CREATE TYPE attendance_change_kind AS ENUM ('CREATED_QR', 'CREATED_MANUAL', 'INVALIDATED', 'RESTORED');
CREATE TYPE invalidation_reason AS ENUM (
  'INCORRECT_ENTRY', 'CONFIRMED_PROXY', 'DUPLICATE_OR_ERRONEOUS', 'IDENTITY_ENROLLMENT_MISMATCH', 'OTHER'
);
CREATE TYPE link_state AS ENUM ('PROVISIONAL', 'REVIEW_REQUIRED', 'CONFIRMED', 'REJECTED');
CREATE TYPE confirmed_basis AS ENUM (
  'ROSTER_ID_MATCH', 'ROSTER_EMAIL_MATCH', 'LECTURER_IDENTITY_CONFIRMED', 'LECTURER_ENROLLMENT_CONFIRMED'
);
CREATE TYPE review_kind AS ENUM ('SYSTEM_MATCH', 'IDENTITY', 'ENROLLMENT');
CREATE TYPE review_decision AS ENUM (
  'SYSTEM_MATCH', 'SYSTEM_DOWNGRADE', 'SYSTEM_REPOINT',
  'CONFIRM', 'KEEP_PROVISIONAL', 'MARK_REVIEW_REQUIRED', 'REJECT', 'RELINK'
);
CREATE TYPE flag_kind AS ENUM ('PROXY_SUSPECTED', 'CONFLICTING_STUDENT_ID', 'AMBIGUOUS_ROSTER_MATCH');
CREATE TYPE flag_origin AS ENUM ('SYSTEM', 'LECTURER');
CREATE TYPE flag_state AS ENUM ('OPEN', 'UNDER_REVIEW', 'DISMISSED', 'SUBSTANTIATED');
CREATE TYPE scan_outcome AS ENUM (
  'ACCEPTED', 'DUPLICATE_EXISTING', 'REJECTED_TOKEN_EXPIRED', 'REJECTED_TOKEN_REVOKED',
  'REJECTED_SESSION_NOT_STARTED', 'REJECTED_SESSION_CLOSED', 'REJECTED_SESSION_ENDED'
);
CREATE TYPE account_token_purpose AS ENUM ('EMAIL_VERIFICATION', 'PASSWORD_RESET');
CREATE TYPE roster_import_status AS ENUM ('APPLIED', 'REJECTED');
CREATE TYPE export_kind AS ENUM ('ATTENDANCE', 'SCAN_HISTORY');
CREATE TYPE export_format AS ENUM ('CSV', 'XLSX', 'PDF', 'DOCX');
CREATE TYPE export_status AS ENUM ('READY', 'FAILED', 'EXPIRED');
CREATE TYPE audit_class AS ENUM ('DOMAIN', 'SECURITY');
CREATE TYPE audit_actor_type AS ENUM ('LECTURER', 'STUDENT', 'SYSTEM', 'OPERATOR', 'ANONYMOUS');
CREATE TYPE audit_outcome AS ENUM ('SUCCESS', 'DENIED');

-- ---------------------------------------------------------------------------------------------
-- Accounts and authentication
-- ---------------------------------------------------------------------------------------------
CREATE TABLE terms (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name       text NOT NULL UNIQUE,
  starts_on  date NOT NULL,
  ends_on    date NOT NULL,
  CONSTRAINT terms_dates CHECK (ends_on > starts_on)
);

CREATE TABLE users (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  role               user_role NOT NULL,
  email              citext NOT NULL UNIQUE,
  email_verified_at  timestamptz,
  full_name          text NOT NULL,
  student_id_norm    text,
  student_id_display text,
  password_hash      text NOT NULL,
  status             text NOT NULL DEFAULT 'ACTIVE',
  created_at         timestamptz NOT NULL DEFAULT clock_timestamp(),
  -- One account per student ID, enforced atomically by the database.
  CONSTRAINT users_student_id_norm_key UNIQUE (student_id_norm),
  -- Target for composite foreign keys that must reference a user of a specific role.
  CONSTRAINT users_id_role_key UNIQUE (id, role),
  CONSTRAINT users_full_name_nonempty CHECK (length(trim(full_name)) > 0),
  CONSTRAINT users_status_valid CHECK (status IN ('ACTIVE', 'DISABLED')),
  CONSTRAINT users_student_id_iff_student CHECK (
    (role = 'STUDENT') = (student_id_norm IS NOT NULL AND student_id_display IS NOT NULL)
    AND (student_id_norm IS NULL) = (student_id_display IS NULL)
  )
);

CREATE TABLE account_tokens (
  token_hash bytea PRIMARY KEY,
  user_id    uuid NOT NULL REFERENCES users (id),
  purpose    account_token_purpose NOT NULL,
  expires_at timestamptz NOT NULL,
  used_at    timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX account_tokens_user_purpose_idx ON account_tokens (user_id, purpose);

CREATE TABLE auth_sessions (
  id_hash             bytea PRIMARY KEY,
  user_id             uuid NOT NULL REFERENCES users (id),
  created_at          timestamptz NOT NULL DEFAULT clock_timestamp(),
  last_seen_at        timestamptz NOT NULL DEFAULT clock_timestamp(),
  idle_expires_at     timestamptz NOT NULL,
  absolute_expires_at timestamptz NOT NULL,
  revoked_at          timestamptz,
  revoke_reason       text
);
CREATE INDEX auth_sessions_user_idx ON auth_sessions (user_id);

CREATE TABLE rate_limits (
  key_hash     bytea NOT NULL,
  window_start timestamptz NOT NULL,
  count        integer NOT NULL DEFAULT 0 CHECK (count >= 0),
  PRIMARY KEY (key_hash, window_start)
);

-- ---------------------------------------------------------------------------------------------
-- Courses, assignments, rosters
-- ---------------------------------------------------------------------------------------------
CREATE TABLE courses (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  term_id    uuid NOT NULL REFERENCES terms (id),
  code       text NOT NULL,
  title      text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT courses_term_code_key UNIQUE (term_id, code)
);

CREATE TABLE lecturer_courses (
  course_id     uuid NOT NULL REFERENCES courses (id),
  lecturer_id   uuid NOT NULL,
  lecturer_role user_role NOT NULL DEFAULT 'LECTURER',
  assigned_at   timestamptz NOT NULL DEFAULT clock_timestamp(),
  ended_at      timestamptz,
  PRIMARY KEY (course_id, lecturer_id),
  CONSTRAINT lecturer_courses_role_is_lecturer CHECK (lecturer_role = 'LECTURER'),
  CONSTRAINT lecturer_courses_lecturer_fk
    FOREIGN KEY (lecturer_id, lecturer_role) REFERENCES users (id, role),
  CONSTRAINT lecturer_courses_dates CHECK (ended_at IS NULL OR ended_at >= assigned_at)
);

CREATE TABLE roster_imports (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  course_id   uuid NOT NULL REFERENCES courses (id),
  uploaded_by uuid NOT NULL REFERENCES users (id),
  file_sha256 bytea NOT NULL,
  row_count   integer NOT NULL CHECK (row_count >= 0),
  status      roster_import_status NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX roster_imports_course_idx ON roster_imports (course_id, created_at);

CREATE TABLE roster_entries (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  course_id       uuid NOT NULL REFERENCES courses (id),
  import_id       uuid NOT NULL REFERENCES roster_imports (id),
  student_id_norm text NOT NULL,
  full_name       text NOT NULL,
  school_email    citext,
  retired_at      timestamptz,
  superseded_by   uuid REFERENCES roster_entries (id),
  created_at      timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT roster_entries_id_course_key UNIQUE (id, course_id),
  CONSTRAINT roster_entries_superseded_requires_retired CHECK (superseded_by IS NULL OR retired_at IS NOT NULL)
);
-- Imported entries are never overwritten: only one ACTIVE entry per ID and per email in a course.
CREATE UNIQUE INDEX roster_entries_active_id_key
  ON roster_entries (course_id, student_id_norm) WHERE retired_at IS NULL;
CREATE UNIQUE INDEX roster_entries_active_email_key
  ON roster_entries (course_id, school_email) WHERE retired_at IS NULL AND school_email IS NOT NULL;

-- Course-scoped association between a student account and a course (the "identity/enrollment
-- review" dimension). The deferred FK to identity_reviews is added below.
CREATE TABLE roster_links (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  course_id         uuid NOT NULL REFERENCES courses (id),
  student_id        uuid NOT NULL,
  student_role      user_role NOT NULL DEFAULT 'STUDENT',
  roster_entry_id   uuid,
  state             link_state NOT NULL,
  confirmed_basis   confirmed_basis,
  current_review_no integer NOT NULL DEFAULT 1,
  created_at        timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT roster_links_course_student_key UNIQUE (course_id, student_id),
  CONSTRAINT roster_links_id_course_student_key UNIQUE (id, course_id, student_id),
  CONSTRAINT roster_links_id_course_key UNIQUE (id, course_id),
  CONSTRAINT roster_links_role_is_student CHECK (student_role = 'STUDENT'),
  CONSTRAINT roster_links_student_fk
    FOREIGN KEY (student_id, student_role) REFERENCES users (id, role),
  CONSTRAINT roster_links_entry_fk
    FOREIGN KEY (roster_entry_id, course_id) REFERENCES roster_entries (id, course_id),
  CONSTRAINT roster_links_basis_iff_confirmed CHECK ((state = 'CONFIRMED') = (confirmed_basis IS NOT NULL)),
  CONSTRAINT roster_links_roster_basis_needs_entry CHECK (
    confirmed_basis NOT IN ('ROSTER_ID_MATCH', 'ROSTER_EMAIL_MATCH') OR roster_entry_id IS NOT NULL
  )
);
-- A roster entry has at most one holder; a second claimant must go through review without the entry.
CREATE UNIQUE INDEX roster_links_entry_holder_key
  ON roster_links (roster_entry_id) WHERE roster_entry_id IS NOT NULL AND state <> 'REJECTED';

-- ---------------------------------------------------------------------------------------------
-- Class sessions
-- ---------------------------------------------------------------------------------------------
CREATE TABLE class_sessions (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  course_id              uuid NOT NULL REFERENCES courses (id),
  created_by             uuid NOT NULL REFERENCES users (id),
  title                  text NOT NULL,
  session_date           date NOT NULL,
  state                  session_state NOT NULL DEFAULT 'NOT_STARTED',
  started_at             timestamptz,
  started_by             uuid REFERENCES users (id),
  check_in_deadline      timestamptz,
  check_in_closed_at     timestamptz,
  check_in_closed_reason close_reason,
  ended_at               timestamptz,
  ended_by               uuid REFERENCES users (id),
  qr_not_before          timestamptz,
  created_at             timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT class_sessions_id_course_key UNIQUE (id, course_id),
  CONSTRAINT class_sessions_title_nonempty CHECK (length(trim(title)) > 0),
  CONSTRAINT class_sessions_deadline_after_start CHECK (check_in_deadline > started_at),
  CONSTRAINT class_sessions_end_after_start CHECK (ended_at >= started_at),
  CONSTRAINT class_sessions_deadline_close_instant CHECK (
    check_in_closed_reason IS DISTINCT FROM 'DEADLINE' OR check_in_closed_at = check_in_deadline
  ),
  CONSTRAINT class_sessions_ended_close_instant CHECK (
    check_in_closed_reason IS DISTINCT FROM 'ENDED_BY_LECTURER' OR check_in_closed_at = ended_at
  ),
  -- Which timestamps/actors must (not) be present in each lifecycle state.
  CONSTRAINT class_sessions_state_shape CHECK (
    (state = 'NOT_STARTED'
      AND started_at IS NULL AND started_by IS NULL AND check_in_deadline IS NULL
      AND check_in_closed_at IS NULL AND check_in_closed_reason IS NULL
      AND ended_at IS NULL AND ended_by IS NULL)
    OR (state = 'CHECK_IN_OPEN'
      AND started_at IS NOT NULL AND started_by IS NOT NULL AND check_in_deadline IS NOT NULL
      AND check_in_closed_at IS NULL AND check_in_closed_reason IS NULL
      AND ended_at IS NULL AND ended_by IS NULL)
    OR (state = 'CHECK_IN_CLOSED'
      AND started_at IS NOT NULL AND started_by IS NOT NULL AND check_in_deadline IS NOT NULL
      AND check_in_closed_at IS NOT NULL AND check_in_closed_reason = 'DEADLINE'
      AND ended_at IS NULL AND ended_by IS NULL)
    OR (state = 'ENDED'
      AND started_at IS NOT NULL AND started_by IS NOT NULL AND check_in_deadline IS NOT NULL
      AND check_in_closed_at IS NOT NULL AND check_in_closed_reason IS NOT NULL
      AND ended_at IS NOT NULL AND ended_by IS NOT NULL)
  )
);
CREATE INDEX class_sessions_course_date_idx ON class_sessions (course_id, session_date);
CREATE INDEX class_sessions_open_deadline_idx
  ON class_sessions (check_in_deadline) WHERE state = 'CHECK_IN_OPEN';

-- Guard for the system's most important invariant (no check-in after closure). Keeps illegal
-- transitions out even if a future code path, or hand-written SQL, forgets the application rules.
CREATE FUNCTION class_sessions_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.course_id <> OLD.course_id OR NEW.created_by <> OLD.created_by THEN
    RAISE EXCEPTION 'class_sessions: course_id and created_by are immutable'
      USING ERRCODE = 'check_violation';
  END IF;

  IF OLD.state = 'ENDED' THEN
    RAISE EXCEPTION 'class_sessions: an ENDED session is terminal and cannot be updated'
      USING ERRCODE = 'check_violation';
  END IF;

  IF OLD.started_at IS NOT NULL AND NEW.started_at IS DISTINCT FROM OLD.started_at THEN
    RAISE EXCEPTION 'class_sessions: started_at cannot change once set'
      USING ERRCODE = 'check_violation';
  END IF;

  IF OLD.state <> NEW.state AND NOT (
       (OLD.state = 'NOT_STARTED'     AND NEW.state = 'CHECK_IN_OPEN')
    OR (OLD.state = 'CHECK_IN_OPEN'   AND NEW.state IN ('CHECK_IN_CLOSED', 'ENDED'))
    OR (OLD.state = 'CHECK_IN_CLOSED' AND NEW.state = 'ENDED')
  ) THEN
    RAISE EXCEPTION 'class_sessions: illegal transition % -> %', OLD.state, NEW.state
      USING ERRCODE = 'check_violation';
  END IF;

  IF OLD.state = 'CHECK_IN_OPEN' THEN
    -- The deadline may only move forward, and only while the session stays open.
    IF NEW.check_in_deadline < OLD.check_in_deadline THEN
      RAISE EXCEPTION 'class_sessions: check_in_deadline can only move forward'
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.state <> 'CHECK_IN_OPEN' AND NEW.check_in_deadline IS DISTINCT FROM OLD.check_in_deadline THEN
      RAISE EXCEPTION 'class_sessions: closing or ending cannot change check_in_deadline'
        USING ERRCODE = 'check_violation';
    END IF;
  ELSIF OLD.state = 'CHECK_IN_CLOSED' THEN
    IF NEW.check_in_deadline IS DISTINCT FROM OLD.check_in_deadline
       OR NEW.check_in_closed_at IS DISTINCT FROM OLD.check_in_closed_at
       OR NEW.check_in_closed_reason IS DISTINCT FROM OLD.check_in_closed_reason THEN
      RAISE EXCEPTION 'class_sessions: a closed check-in window cannot be changed or reopened'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  IF OLD.qr_not_before IS NOT NULL
     AND (NEW.qr_not_before IS NULL OR NEW.qr_not_before < OLD.qr_not_before) THEN
    RAISE EXCEPTION 'class_sessions: qr_not_before can only move forward'
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END
$$;

CREATE TRIGGER class_sessions_guard_trg
  BEFORE UPDATE ON class_sessions
  FOR EACH ROW EXECUTE FUNCTION class_sessions_guard();

CREATE TABLE session_extensions (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id        uuid NOT NULL REFERENCES class_sessions (id),
  extended_by       uuid NOT NULL REFERENCES users (id),
  previous_deadline timestamptz NOT NULL,
  new_deadline      timestamptz NOT NULL,
  reason            text NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT session_extensions_forward_only CHECK (new_deadline > previous_deadline),
  CONSTRAINT session_extensions_reason_nonempty CHECK (length(trim(reason)) > 0),
  CONSTRAINT session_extensions_once_per_deadline UNIQUE (session_id, previous_deadline)
);

-- ---------------------------------------------------------------------------------------------
-- Attendance and its history
-- ---------------------------------------------------------------------------------------------
CREATE TABLE attendance_records (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id        uuid NOT NULL,
  course_id         uuid NOT NULL,
  student_id        uuid NOT NULL,
  student_role      user_role NOT NULL DEFAULT 'STUDENT',
  link_id           uuid NOT NULL,
  status            attendance_status NOT NULL DEFAULT 'PRESENT',
  source            attendance_source NOT NULL,
  manual_marked_by  uuid REFERENCES users (id),
  recorded_at       timestamptz NOT NULL DEFAULT clock_timestamp(),
  current_rev_no    integer NOT NULL DEFAULT 1,
  -- One effective record per authenticated student per session.
  CONSTRAINT attendance_session_student_key UNIQUE (session_id, student_id),
  CONSTRAINT attendance_id_course_key UNIQUE (id, course_id),
  CONSTRAINT attendance_role_is_student CHECK (student_role = 'STUDENT'),
  CONSTRAINT attendance_session_fk
    FOREIGN KEY (session_id, course_id) REFERENCES class_sessions (id, course_id),
  CONSTRAINT attendance_student_fk
    FOREIGN KEY (student_id, student_role) REFERENCES users (id, role),
  CONSTRAINT attendance_link_fk
    FOREIGN KEY (link_id, course_id, student_id) REFERENCES roster_links (id, course_id, student_id),
  CONSTRAINT attendance_manual_actor CHECK ((source = 'MANUAL') = (manual_marked_by IS NOT NULL))
);
CREATE INDEX attendance_student_idx ON attendance_records (student_id);
CREATE INDEX attendance_link_idx ON attendance_records (link_id);

CREATE TABLE attendance_revisions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  attendance_id   uuid NOT NULL REFERENCES attendance_records (id),
  rev_no          integer NOT NULL CHECK (rev_no >= 1),
  change_kind     attendance_change_kind NOT NULL,
  from_status     attendance_status,
  to_status       attendance_status NOT NULL,
  actor_user_id   uuid NOT NULL REFERENCES users (id),
  reason_category invalidation_reason,
  explanation     text,
  recorded_at     timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT attendance_revisions_rev_key UNIQUE (attendance_id, rev_no),
  CONSTRAINT attendance_revisions_rev_status_key UNIQUE (attendance_id, rev_no, to_status),
  CONSTRAINT attendance_revisions_first_is_creation CHECK (
    (rev_no = 1) = (change_kind IN ('CREATED_QR', 'CREATED_MANUAL'))
  ),
  CONSTRAINT attendance_revisions_status_flow CHECK (
    (change_kind IN ('CREATED_QR', 'CREATED_MANUAL') AND from_status IS NULL AND to_status = 'PRESENT')
    OR (change_kind = 'INVALIDATED' AND from_status = 'PRESENT' AND to_status = 'INVALIDATED')
    OR (change_kind = 'RESTORED' AND from_status = 'INVALIDATED' AND to_status = 'PRESENT')
  ),
  CONSTRAINT attendance_revisions_invalidation_reason CHECK (
    change_kind <> 'INVALIDATED'
    OR (reason_category IS NOT NULL AND length(trim(coalesce(explanation, ''))) >= 10)
  ),
  CONSTRAINT attendance_revisions_category_only_on_invalidation CHECK (
    change_kind = 'INVALIDATED' OR reason_category IS NULL
  ),
  CONSTRAINT attendance_revisions_explanation_required CHECK (
    change_kind NOT IN ('RESTORED', 'CREATED_MANUAL') OR length(trim(coalesce(explanation, ''))) >= 10
  )
);

-- The current status must always equal the latest recorded revision's resulting status.
-- Deferred so the record and its first revision can be inserted in one transaction.
ALTER TABLE attendance_records
  ADD CONSTRAINT attendance_status_matches_revision
  FOREIGN KEY (id, current_rev_no, status)
  REFERENCES attendance_revisions (attendance_id, rev_no, to_status)
  DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE scan_attempts (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id        uuid NOT NULL REFERENCES class_sessions (id),
  student_id        uuid NOT NULL REFERENCES users (id),
  client_attempt_id uuid NOT NULL,
  token_jti         text NOT NULL,
  token_kid         text NOT NULL,
  outcome           scan_outcome NOT NULL,
  attendance_id     uuid REFERENCES attendance_records (id),
  received_at       timestamptz NOT NULL DEFAULT clock_timestamp(),
  ip_hash           bytea,
  ua_family         text,
  CONSTRAINT scan_attempts_client_attempt_key UNIQUE (student_id, client_attempt_id),
  CONSTRAINT scan_attempts_attendance_iff_recorded CHECK (
    (outcome IN ('ACCEPTED', 'DUPLICATE_EXISTING')) = (attendance_id IS NOT NULL)
  )
);
CREATE INDEX scan_attempts_session_idx ON scan_attempts (session_id, received_at);
CREATE INDEX scan_attempts_received_idx ON scan_attempts (received_at);

-- ---------------------------------------------------------------------------------------------
-- Investigation flags and association review history
-- ---------------------------------------------------------------------------------------------
CREATE TABLE investigation_flags (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  course_id        uuid NOT NULL REFERENCES courses (id),
  session_id       uuid,
  roster_link_id   uuid,
  attendance_id    uuid,
  related_link_id  uuid,
  kind             flag_kind NOT NULL,
  origin           flag_origin NOT NULL,
  raised_by        uuid REFERENCES users (id),
  state            flag_state NOT NULL DEFAULT 'OPEN',
  current_event_no integer NOT NULL DEFAULT 1,
  opened_at        timestamptz NOT NULL DEFAULT clock_timestamp(),
  detail           jsonb NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT flags_session_fk FOREIGN KEY (session_id, course_id) REFERENCES class_sessions (id, course_id),
  CONSTRAINT flags_link_fk FOREIGN KEY (roster_link_id, course_id) REFERENCES roster_links (id, course_id),
  CONSTRAINT flags_related_link_fk FOREIGN KEY (related_link_id, course_id) REFERENCES roster_links (id, course_id),
  CONSTRAINT flags_attendance_fk FOREIGN KEY (attendance_id, course_id) REFERENCES attendance_records (id, course_id),
  CONSTRAINT flags_has_subject CHECK (session_id IS NOT NULL OR roster_link_id IS NOT NULL OR attendance_id IS NOT NULL),
  CONSTRAINT flags_origin_actor CHECK ((origin = 'LECTURER') = (raised_by IS NOT NULL))
);
CREATE INDEX flags_course_state_idx ON investigation_flags (course_id, state);
-- No duplicate ACTIVE flag of the same kind on the same subject.
CREATE UNIQUE INDEX flags_active_attendance_key
  ON investigation_flags (kind, attendance_id)
  WHERE attendance_id IS NOT NULL AND state IN ('OPEN', 'UNDER_REVIEW');
CREATE UNIQUE INDEX flags_active_link_key
  ON investigation_flags (kind, roster_link_id)
  WHERE attendance_id IS NULL AND roster_link_id IS NOT NULL AND state IN ('OPEN', 'UNDER_REVIEW');

CREATE TABLE investigation_flag_events (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  flag_id       uuid NOT NULL REFERENCES investigation_flags (id),
  event_no      integer NOT NULL CHECK (event_no >= 1),
  from_state    flag_state,
  to_state      flag_state NOT NULL,
  actor_user_id uuid REFERENCES users (id),
  note          text,
  at            timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT flag_events_no_key UNIQUE (flag_id, event_no),
  CONSTRAINT flag_events_no_state_key UNIQUE (flag_id, event_no, to_state),
  CONSTRAINT flag_events_first CHECK ((event_no = 1) = (from_state IS NULL)),
  CONSTRAINT flag_events_resolution_note CHECK (
    NOT (to_state IN ('DISMISSED', 'SUBSTANTIATED') OR from_state IN ('DISMISSED', 'SUBSTANTIATED'))
    OR length(trim(coalesce(note, ''))) >= 10
  )
);

ALTER TABLE investigation_flags
  ADD CONSTRAINT flags_state_matches_event
  FOREIGN KEY (id, current_event_no, state)
  REFERENCES investigation_flag_events (flag_id, event_no, to_state)
  DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE identity_reviews (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  link_id         uuid NOT NULL REFERENCES roster_links (id),
  review_no       integer NOT NULL CHECK (review_no >= 1),
  review_kind     review_kind NOT NULL,
  decision        review_decision NOT NULL,
  from_state      link_state,
  to_state        link_state NOT NULL,
  from_entry_id   uuid REFERENCES roster_entries (id),
  to_entry_id     uuid REFERENCES roster_entries (id),
  basis           confirmed_basis,
  actor_user_id   uuid REFERENCES users (id),
  explanation     text,
  flag_id         uuid REFERENCES investigation_flags (id),
  decided_at      timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT identity_reviews_no_key UNIQUE (link_id, review_no),
  CONSTRAINT identity_reviews_no_state_key UNIQUE (link_id, review_no, to_state),
  CONSTRAINT identity_reviews_first CHECK ((review_no = 1) = (from_state IS NULL)),
  CONSTRAINT identity_reviews_system_iff_no_actor CHECK (
    (actor_user_id IS NULL) = (decision IN ('SYSTEM_MATCH', 'SYSTEM_DOWNGRADE', 'SYSTEM_REPOINT'))
  ),
  CONSTRAINT identity_reviews_lecturer_explanation CHECK (
    actor_user_id IS NULL OR length(trim(coalesce(explanation, ''))) >= 10
  )
);

ALTER TABLE roster_links
  ADD CONSTRAINT roster_links_state_matches_review
  FOREIGN KEY (id, current_review_no, state)
  REFERENCES identity_reviews (link_id, review_no, to_state)
  DEFERRABLE INITIALLY DEFERRED;

-- ---------------------------------------------------------------------------------------------
-- Exports and audit
-- ---------------------------------------------------------------------------------------------
CREATE TABLE export_records (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  course_id    uuid NOT NULL REFERENCES courses (id),
  session_id   uuid REFERENCES class_sessions (id),
  requested_by uuid NOT NULL REFERENCES users (id),
  report_kind  export_kind NOT NULL,
  format       export_format NOT NULL,
  params       jsonb NOT NULL DEFAULT '{}'::jsonb,
  status       export_status NOT NULL,
  row_count    integer CHECK (row_count >= 0),
  file_sha256  bytea,
  storage_key  text,
  requested_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  ready_at     timestamptz,
  expires_at   timestamptz,
  CONSTRAINT export_ready_fields CHECK (
    status <> 'READY' OR (ready_at IS NOT NULL AND expires_at IS NOT NULL AND storage_key IS NOT NULL)
  )
);
CREATE INDEX export_records_requester_idx ON export_records (requested_by, requested_at);

CREATE TABLE audit_events (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  occurred_at   timestamptz NOT NULL DEFAULT clock_timestamp(),
  class         audit_class NOT NULL,
  actor_type    audit_actor_type NOT NULL,
  actor_user_id uuid REFERENCES users (id),
  action        text NOT NULL,
  outcome       audit_outcome NOT NULL DEFAULT 'SUCCESS',
  course_id     uuid REFERENCES courses (id),
  session_id    uuid REFERENCES class_sessions (id),
  entity_type   text,
  entity_id     text,
  request_id    text,
  summary       jsonb NOT NULL DEFAULT '{}'::jsonb,
  ip_hash       bytea,
  retain_until  date NOT NULL,
  CONSTRAINT audit_action_nonempty CHECK (length(trim(action)) > 0)
);
CREATE INDEX audit_events_course_idx ON audit_events (course_id, id);
CREATE INDEX audit_events_entity_idx ON audit_events (entity_type, entity_id);
CREATE INDEX audit_events_retain_idx ON audit_events (retain_until);

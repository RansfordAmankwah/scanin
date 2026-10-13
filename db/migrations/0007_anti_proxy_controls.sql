-- Anti-proxy controls: room headcount reconciliation, randomised spot checks, and disputes.
--
-- Principles:
--   * Everything here is a REVIEW SIGNAL for a lecturer. Nothing in this migration changes an
--     attendance status by itself; attendance corrections still go through attendance_revisions.
--   * History is append-only. Mutable parent rows (spot_check_items, attendance_disputes) carry only
--     their current state, and a deferred foreign key forces that state to equal the latest event.
--   * Illegal transitions are refused by CHECK constraints, not only by application code.

-- ---------------------------------------------------------------------------------------------
-- Headcount: the lecturer's approximate count of people physically in the room.
-- Each row is a revision; the current value is the highest rev_no for the session.
-- ---------------------------------------------------------------------------------------------
CREATE TABLE session_headcounts (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id         uuid NOT NULL,
  course_id          uuid NOT NULL,
  rev_no             integer NOT NULL CHECK (rev_no >= 1),
  headcount          integer NOT NULL CHECK (headcount BETWEEN 0 AND 100000),
  previous_headcount integer CHECK (previous_headcount BETWEEN 0 AND 100000),
  explanation        text CHECK (explanation IS NULL OR length(explanation) <= 2000),
  recorded_by        uuid NOT NULL REFERENCES users (id),
  recorded_at        timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT headcounts_session_rev_key UNIQUE (session_id, rev_no),
  CONSTRAINT headcounts_session_fk FOREIGN KEY (session_id, course_id)
    REFERENCES class_sessions (id, course_id),
  CONSTRAINT headcounts_first_has_no_previous CHECK ((rev_no = 1) = (previous_headcount IS NULL))
);

-- A lecturer's written response to a flagged discrepancy (for example "six students arrived late").
CREATE TABLE reconciliation_notes (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id     uuid NOT NULL,
  course_id      uuid NOT NULL,
  note           text NOT NULL CHECK (length(trim(note)) >= 10 AND length(note) <= 2000),
  status_at_time text NOT NULL,
  headcount_rev  integer,
  recorded_by    uuid NOT NULL REFERENCES users (id),
  recorded_at    timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT reconciliation_notes_session_fk FOREIGN KEY (session_id, course_id)
    REFERENCES class_sessions (id, course_id)
);
CREATE INDEX reconciliation_notes_session_idx ON reconciliation_notes (session_id, recorded_at);

-- ---------------------------------------------------------------------------------------------
-- Spot checks
-- ---------------------------------------------------------------------------------------------
CREATE TYPE spot_check_state AS ENUM ('PENDING', 'VERIFIED', 'NOT_PRESENT', 'COULD_NOT_VERIFY');
CREATE TYPE verification_method AS ENUM ('STUDENT_ID_CARD', 'ROSTER_PHOTO', 'OTHER_OFFICIAL_ID');

-- One round of selection. `policy` snapshots the settings in force, so a later change of settings
-- never rewrites how an earlier sample was drawn.
CREATE TABLE spot_checks (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id     uuid NOT NULL,
  course_id      uuid NOT NULL,
  created_by     uuid NOT NULL REFERENCES users (id),
  request_id     uuid,
  requested_size integer NOT NULL CHECK (requested_size BETWEEN 1 AND 1000),
  eligible_count integer NOT NULL CHECK (eligible_count >= 0),
  selected_count integer NOT NULL CHECK (selected_count >= 0),
  policy         jsonb NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT spot_checks_session_fk FOREIGN KEY (session_id, course_id)
    REFERENCES class_sessions (id, course_id),
  CONSTRAINT spot_checks_request_key UNIQUE (session_id, request_id),
  CONSTRAINT spot_checks_selected_within_requested CHECK (selected_count <= requested_size)
);

CREATE TABLE spot_check_items (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  spot_check_id    uuid NOT NULL REFERENCES spot_checks (id),
  session_id       uuid NOT NULL,
  course_id        uuid NOT NULL,
  attendance_id    uuid NOT NULL,
  student_id       uuid NOT NULL REFERENCES users (id),
  -- Why this student was picked. RISK_WEIGHTED means evidence in our own data raised their chance;
  -- it never means anything about their guilt.
  selection_reason text NOT NULL CHECK (selection_reason IN ('RANDOM', 'RISK_WEIGHTED')),
  weight           numeric(6, 3) NOT NULL CHECK (weight > 0),
  risk_factors     jsonb NOT NULL DEFAULT '[]'::jsonb,
  state            spot_check_state NOT NULL DEFAULT 'PENDING',
  current_event_no integer CHECK (current_event_no >= 1),
  created_at       timestamptz NOT NULL DEFAULT clock_timestamp(),
  -- A student is sampled at most once per session.
  CONSTRAINT spot_check_items_session_student_key UNIQUE (session_id, student_id),
  CONSTRAINT spot_check_items_session_fk FOREIGN KEY (session_id, course_id)
    REFERENCES class_sessions (id, course_id),
  CONSTRAINT spot_check_items_attendance_fk FOREIGN KEY (attendance_id, course_id)
    REFERENCES attendance_records (id, course_id),
  CONSTRAINT spot_check_items_pending_has_no_event CHECK ((state = 'PENDING') = (current_event_no IS NULL))
);
CREATE INDEX spot_check_items_round_idx ON spot_check_items (spot_check_id);
CREATE INDEX spot_check_items_attendance_idx ON spot_check_items (attendance_id);
CREATE INDEX spot_check_items_student_idx ON spot_check_items (student_id, created_at);

CREATE TABLE spot_check_events (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  item_id       uuid NOT NULL REFERENCES spot_check_items (id),
  event_no      integer NOT NULL CHECK (event_no >= 1),
  from_state    spot_check_state NOT NULL,
  to_state      spot_check_state NOT NULL,
  method        verification_method,
  explanation   text CHECK (explanation IS NULL OR length(explanation) <= 2000),
  -- Lets a client retry a submission safely: the same request id can only ever be recorded once.
  request_id    uuid NOT NULL,
  actor_user_id uuid NOT NULL REFERENCES users (id),
  at            timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT spot_check_events_no_key UNIQUE (item_id, event_no),
  CONSTRAINT spot_check_events_no_state_key UNIQUE (item_id, event_no, to_state),
  CONSTRAINT spot_check_events_request_key UNIQUE (item_id, request_id),
  CONSTRAINT spot_check_events_first CHECK ((event_no = 1) = (from_state = 'PENDING')),
  -- The legal transitions. Everything else is refused by the database.
  CONSTRAINT spot_check_events_legal CHECK (
    (from_state = 'PENDING' AND to_state IN ('VERIFIED', 'NOT_PRESENT', 'COULD_NOT_VERIFY'))
    OR (from_state = 'COULD_NOT_VERIFY' AND to_state IN ('VERIFIED', 'NOT_PRESENT'))
    OR (from_state = 'VERIFIED' AND to_state = 'NOT_PRESENT')      -- a correction
    OR (from_state = 'NOT_PRESENT' AND to_state = 'VERIFIED')      -- a correction
  ),
  -- A verification says how it was done; other outcomes do not claim a method.
  CONSTRAINT spot_check_events_method CHECK ((to_state = 'VERIFIED') = (method IS NOT NULL)),
  -- A negative finding, and any correction of an earlier finding, must be explained.
  CONSTRAINT spot_check_events_explained CHECK (
    NOT (to_state = 'NOT_PRESENT' OR from_state IN ('VERIFIED', 'NOT_PRESENT'))
    OR length(trim(coalesce(explanation, ''))) >= 10
  )
);

ALTER TABLE spot_check_items
  ADD CONSTRAINT spot_check_items_state_matches_event
  FOREIGN KEY (id, current_event_no, state)
  REFERENCES spot_check_events (item_id, event_no, to_state)
  DEFERRABLE INITIALLY DEFERRED;

-- ---------------------------------------------------------------------------------------------
-- Disputes: a recorded attendance that a lecturer is reviewing. Separate from the attendance
-- status itself; the student may respond, and a lecturer resolves it with a written reason.
-- ---------------------------------------------------------------------------------------------
CREATE TYPE dispute_state AS ENUM ('OPEN', 'RESOLVED_UPHELD', 'RESOLVED_INVALIDATED');
CREATE TYPE dispute_event_kind AS ENUM ('OPENED', 'STUDENT_RESPONSE', 'RESOLVED_UPHELD', 'RESOLVED_INVALIDATED');

CREATE TABLE attendance_disputes (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  attendance_id    uuid NOT NULL,
  session_id       uuid NOT NULL,
  course_id        uuid NOT NULL,
  student_id       uuid NOT NULL REFERENCES users (id),
  source_item_id   uuid REFERENCES spot_check_items (id),
  state            dispute_state NOT NULL DEFAULT 'OPEN',
  current_event_no integer NOT NULL DEFAULT 1 CHECK (current_event_no >= 1),
  opened_at        timestamptz NOT NULL DEFAULT clock_timestamp(),
  resolved_at      timestamptz,
  resolved_by      uuid REFERENCES users (id),
  CONSTRAINT disputes_session_fk FOREIGN KEY (session_id, course_id)
    REFERENCES class_sessions (id, course_id),
  CONSTRAINT disputes_attendance_fk FOREIGN KEY (attendance_id, course_id)
    REFERENCES attendance_records (id, course_id),
  CONSTRAINT disputes_resolution_complete CHECK (
    (state = 'OPEN') = (resolved_at IS NULL AND resolved_by IS NULL)
  )
);
-- At most one open dispute per attendance record.
CREATE UNIQUE INDEX disputes_open_attendance_key ON attendance_disputes (attendance_id) WHERE state = 'OPEN';
CREATE INDEX disputes_session_idx ON attendance_disputes (session_id, state);
CREATE INDEX disputes_student_idx ON attendance_disputes (student_id);

CREATE TABLE attendance_dispute_events (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  dispute_id    uuid NOT NULL REFERENCES attendance_disputes (id),
  event_no      integer NOT NULL CHECK (event_no >= 1),
  kind          dispute_event_kind NOT NULL,
  to_state      dispute_state NOT NULL,
  actor_user_id uuid NOT NULL REFERENCES users (id),
  note          text CHECK (note IS NULL OR length(note) <= 2000),
  at            timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT dispute_events_no_key UNIQUE (dispute_id, event_no),
  CONSTRAINT dispute_events_no_state_key UNIQUE (dispute_id, event_no, to_state),
  CONSTRAINT dispute_events_first CHECK ((event_no = 1) = (kind = 'OPENED')),
  CONSTRAINT dispute_events_kind_state CHECK (
    (kind IN ('OPENED', 'STUDENT_RESPONSE') AND to_state = 'OPEN')
    OR (kind = 'RESOLVED_UPHELD' AND to_state = 'RESOLVED_UPHELD')
    OR (kind = 'RESOLVED_INVALIDATED' AND to_state = 'RESOLVED_INVALIDATED')
  ),
  -- Resolving needs a written reason; a student's response must say something.
  CONSTRAINT dispute_events_noted CHECK (
    (kind IN ('RESOLVED_UPHELD', 'RESOLVED_INVALIDATED') AND length(trim(coalesce(note, ''))) >= 10)
    OR (kind = 'STUDENT_RESPONSE' AND length(trim(coalesce(note, ''))) >= 1)
    OR kind = 'OPENED'
  )
);

ALTER TABLE attendance_disputes
  ADD CONSTRAINT disputes_state_matches_event
  FOREIGN KEY (id, current_event_no, state)
  REFERENCES attendance_dispute_events (dispute_id, event_no, to_state)
  DEFERRABLE INITIALLY DEFERRED;

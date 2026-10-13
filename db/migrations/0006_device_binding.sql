-- Device binding: one phone checking in several students for the same class.
--
-- The browser keeps a random id (never a hardware identifier). The server stores only a keyed hash of
-- it, so a database leak does not reveal the ids. A device is "used" by a student for a session once
-- that student's check-in is accepted from it; a different student arriving from the same device in
-- the same session is blocked (DEVICE_POLICY=BLOCK, default) or recorded and flagged (FLAG).
--
-- "One check-in per student per session" already holds: attendance_session_student_key UNIQUE
-- (session_id, student_id) in 0001.
ALTER TYPE scan_outcome ADD VALUE IF NOT EXISTS 'REJECTED_DEVICE_REUSED';

ALTER TABLE attendance_records ADD COLUMN device_hash bytea;

CREATE TABLE device_sessions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id  uuid NOT NULL REFERENCES class_sessions (id),
  device_hash bytea NOT NULL,
  student_id  uuid NOT NULL REFERENCES users (id),
  created_at  timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT device_sessions_key UNIQUE (session_id, device_hash, student_id)
);
CREATE INDEX device_sessions_created_idx ON device_sessions (created_at);

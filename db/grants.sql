-- Privileges for the application and retention roles. Re-applied after every migration run, so it
-- must stay idempotent. Placeholders {{app}}, {{retention}} and {{operator}} are replaced by quoted
-- identifiers.
--
-- Model:
--   * The schema owner (the "migrator" role that runs migrations) owns every object and is the only
--     role that can change structure.
--   * {{app}} is what the API connects as. It can never UPDATE or DELETE history: append-only
--     tables get INSERT + SELECT only, and mutable tables get column-level UPDATE.
--   * {{retention}} can only SELECT and DELETE, and is used solely by the purge jobs.
--   * {{operator}} is used only by the operator CLI (no administrator dashboard exists): it can
--     create terms, courses and lecturer accounts and assign lecturers, and nothing else.

REVOKE ALL ON ALL TABLES IN SCHEMA public FROM PUBLIC, {{app}}, {{retention}}, {{operator}};
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM PUBLIC, {{app}}, {{retention}}, {{operator}};

GRANT USAGE ON SCHEMA public TO {{app}}, {{retention}}, {{operator}};

-- Reference data written by the operator; read-only for the app.
GRANT SELECT ON terms, courses, lecturer_courses TO {{app}};

-- Accounts. Role, student ID and e-mail are immutable from the app, and sign-up may only set the
-- columns below: no `role` (defaults to STUDENT) and no `email_verified_at`.
GRANT SELECT ON users TO {{app}};
GRANT INSERT (email, full_name, student_id_norm, student_id_display, password_hash) ON users TO {{app}};
GRANT UPDATE (email_verified_at, password_hash, status) ON users TO {{app}};

GRANT SELECT, INSERT ON account_tokens TO {{app}};
GRANT UPDATE (used_at) ON account_tokens TO {{app}};

GRANT SELECT, INSERT ON auth_sessions TO {{app}};
GRANT UPDATE (last_seen_at, idle_expires_at, revoked_at, revoke_reason) ON auth_sessions TO {{app}};

GRANT SELECT, INSERT, UPDATE, DELETE ON rate_limits TO {{app}};

-- Rosters: imported entries are never overwritten, only retired.
GRANT SELECT, INSERT ON roster_imports TO {{app}};
GRANT SELECT, INSERT ON roster_entries TO {{app}};
GRANT UPDATE (retired_at, superseded_by) ON roster_entries TO {{app}};

GRANT SELECT, INSERT ON roster_links TO {{app}};
GRANT UPDATE (roster_entry_id, state, confirmed_basis, current_review_no) ON roster_links TO {{app}};

-- Sessions.
GRANT SELECT, INSERT ON class_sessions TO {{app}};
GRANT UPDATE (
  title, state, started_at, started_by, check_in_deadline, check_in_closed_at,
  check_in_closed_reason, ended_at, ended_by, qr_not_before
) ON class_sessions TO {{app}};

-- Attendance: status may change, but only together with a new revision (enforced by the FK).
GRANT SELECT, INSERT ON attendance_records TO {{app}};
GRANT UPDATE (status, current_rev_no) ON attendance_records TO {{app}};

GRANT SELECT, INSERT ON investigation_flags TO {{app}};
GRANT UPDATE (state, current_event_no) ON investigation_flags TO {{app}};

GRANT SELECT, INSERT ON export_records TO {{app}};
GRANT UPDATE (status, row_count, file_sha256, storage_key, ready_at, expires_at) ON export_records TO {{app}};

-- Append-only history: INSERT and SELECT only. No UPDATE, no DELETE, ever, for the app.
GRANT SELECT, INSERT ON
  session_extensions,
  attendance_revisions,
  scan_attempts,
  identity_reviews,
  investigation_flag_events,
  audit_events
TO {{app}};

GRANT USAGE ON SEQUENCE audit_events_id_seq TO {{app}};

-- Retention jobs: read and delete only (course-level purge in dependency order, plus the 90-day
-- scan-metadata purge and expired-session cleanup).
GRANT SELECT, DELETE ON
  users, account_tokens, auth_sessions, rate_limits,
  terms, courses, lecturer_courses,
  roster_imports, roster_entries, roster_links, identity_reviews,
  class_sessions, session_extensions,
  attendance_records, attendance_revisions, scan_attempts,
  investigation_flags, investigation_flag_events,
  export_records, audit_events
TO {{retention}};

-- Operator CLI: provisioning only. Lecturer accounts, terms, courses and assignments are created
-- here because the application role deliberately cannot write them.
GRANT SELECT, INSERT ON terms, courses TO {{operator}};
GRANT SELECT, INSERT ON lecturer_courses TO {{operator}};
GRANT UPDATE (ended_at) ON lecturer_courses TO {{operator}};
GRANT SELECT, INSERT ON users TO {{operator}};
GRANT UPDATE (password_hash, status, email_verified_at) ON users TO {{operator}};
GRANT SELECT ON auth_sessions TO {{operator}};
GRANT UPDATE (revoked_at, revoke_reason) ON auth_sessions TO {{operator}};
GRANT SELECT, INSERT ON audit_events TO {{operator}};
GRANT USAGE ON SEQUENCE audit_events_id_seq TO {{operator}};

-- The free trial starts when a lecturer first runs a session, not when they verify their e-mail.
-- This way the 14 days are genuine usage days: verifying early, or setting up a course weeks ahead,
-- no longer burns the trial. The timestamp is stamped once, on the first session start, and never
-- reset. A lecturer who has never run a session has trial_started_at = NULL (trial not yet begun).
ALTER TABLE users ADD COLUMN trial_started_at timestamptz;

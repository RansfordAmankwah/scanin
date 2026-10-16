-- Face-verification pilot, phase 3: spot-check integration.
--
-- A face exception (a check that failed, could not run, or was not completed) always puts the student
-- on the in-person spot-check list for that session. The lecturer sees only that an in-person check
-- is required, never the face sub-reason.

-- Allow FACE_EXCEPTION as a reason a student was selected for a spot check.
ALTER TABLE spot_check_items DROP CONSTRAINT IF EXISTS spot_check_items_selection_reason_check;
ALTER TABLE spot_check_items
  ADD CONSTRAINT spot_check_items_selection_reason_check
  CHECK (selection_reason IN ('RANDOM', 'RISK_WEIGHTED', 'FACE_EXCEPTION'));

-- Forced face-exception students (and the minimum face-verified students) are included ON TOP of the
-- requested sample size, so a round may legitimately select more than it asked for.
ALTER TABLE spot_checks DROP CONSTRAINT IF EXISTS spot_checks_selected_within_requested;

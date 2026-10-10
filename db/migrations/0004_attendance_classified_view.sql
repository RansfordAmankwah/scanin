-- One definition of how each attendance record is classified, used by every screen and export so
-- that totals always agree. Attendance status, the student's course association, and investigation
-- flags are independent dimensions; they are combined here only for counting.
--
-- bucket (mutually exclusive, so nothing is counted twice):
--   INVALIDATED      attendance was invalidated by a lecturer
--   CONFIRMED        present, association confirmed
--   PROVISIONAL      present, association provisional (e.g. the course has no roster)
--   REVIEW_REQUIRED  present, association awaiting or refused by a lecturer (REVIEW_REQUIRED/REJECTED)
-- flagged is an OVERLAY, never a bucket: an active (OPEN / UNDER_REVIEW) flag on the record or on
-- the student's course association.
CREATE VIEW attendance_classified AS
SELECT a.id AS attendance_id,
       a.session_id,
       a.course_id,
       a.student_id,
       a.link_id,
       a.status,
       a.source,
       CASE
         WHEN a.status = 'INVALIDATED' THEN 'INVALIDATED'
         WHEN l.state = 'CONFIRMED'    THEN 'CONFIRMED'
         WHEN l.state = 'PROVISIONAL'  THEN 'PROVISIONAL'
         ELSE 'REVIEW_REQUIRED'
       END AS bucket,
       l.state AS link_state,
       l.confirmed_basis,
       EXISTS (
         SELECT 1 FROM investigation_flags f
          WHERE f.course_id = a.course_id
            AND f.state IN ('OPEN', 'UNDER_REVIEW')
            AND (f.attendance_id = a.id OR f.roster_link_id = a.link_id)
       ) AS flagged
  FROM attendance_records a
  JOIN roster_links l ON l.id = a.link_id;

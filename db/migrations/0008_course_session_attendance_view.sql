-- One definition of "which sessions count for which student", shared by the student's course history,
-- the lecturer's per-student history and every attendance percentage in the product.
--
-- Attribution is already guaranteed by the schema: attendance_records carries course_id, with
-- composite foreign keys to class_sessions (id, course_id) and roster_links (id, course_id, student_id),
-- and nothing can update a record's course. This view adds no guesses; it only states the counting rule.
--
-- One row per (course association, session that has started). A student is only ever paired with
-- sessions of the SAME course, because the join is on roster_links.course_id = class_sessions.course_id.
--
-- THE COUNTING RULE (`counted`): a session counts toward a student's attendance when
--   1. its check-in window has closed (CHECK_IN_CLOSED or ENDED). A session still open is "in progress"
--      for everyone and is counted once it closes, so a percentage never moves while students scan; and
--   2. ScanIn knew the student belonged to the course when it started: the session started on or after
--      `eligible_from` (the earlier of the association's creation and, if the student is on an imported
--      class list, that list entry's creation) and before `eligible_until` (when that class-list entry
--      was retired, if it was). Sessions outside that window have UNKNOWN eligibility and are not guessed
--      into the denominator, unless the student has a present record for them.
-- There is no "cancelled" session state today. If one is ever added it must be excluded here.
CREATE VIEW course_session_attendance AS
SELECT l.id               AS link_id,
       l.course_id,
       l.student_id,
       l.state            AS link_state,
       l.roster_entry_id,
       s.id               AS session_id,
       s.title            AS session_title,
       s.session_date,
       s.state            AS session_state,
       s.started_at,
       w.eligible_from,
       w.eligible_until,
       (s.state IN ('CHECK_IN_CLOSED', 'ENDED')) AS closed,
       a.id               AS attendance_id,
       a.status           AS attendance_status,
       a.source           AS attendance_source,
       c.bucket           AS bucket,
       c.flagged          AS flagged,
       -- COALESCE: with no attendance record `a.status = 'PRESENT'` is NULL, and NULL must read as "no".
       COALESCE(
         s.state IN ('CHECK_IN_CLOSED', 'ENDED')
         AND (   (s.started_at >= w.eligible_from
                  AND (w.eligible_until IS NULL OR s.started_at < w.eligible_until))
              OR a.status = 'PRESENT'),
         false) AS counted
  FROM roster_links l
  JOIN class_sessions s
    ON s.course_id = l.course_id AND s.state <> 'NOT_STARTED'
  LEFT JOIN roster_entries e ON e.id = l.roster_entry_id
  CROSS JOIN LATERAL (
    SELECT LEAST(l.created_at, COALESCE(e.created_at, l.created_at)) AS eligible_from,
           e.retired_at                                              AS eligible_until
  ) w
  LEFT JOIN attendance_records a
    ON a.session_id = s.id AND a.student_id = l.student_id AND a.course_id = l.course_id
  LEFT JOIN attendance_classified c ON c.attendance_id = a.id;

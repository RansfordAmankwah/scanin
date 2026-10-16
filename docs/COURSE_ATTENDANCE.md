# Course-based attendance

Attendance is read **per course**. Students go Home → My courses → one course → one session; lecturers go
Courses → one course → (Sessions | Attendance | Class list | Review) → one student or one session.

## Attribution (no data migration needed)

`attendance_records.course_id` already carries composite foreign keys to `class_sessions(id, course_id)` and
`roster_links(id, course_id, student_id)`. A record therefore cannot point at a session of one course and a
student link of another, and the app role cannot update `course_id`. Courses are always identified by id;
renaming a course changes nothing historical. Nothing is guessed.

Migration `0008_course_session_attendance_view.sql` only adds a read-only view,
`course_session_attendance` (one row per student link × started session of the same course). It is reversible
with `DROP VIEW course_session_attendance`.

## What counts

A session counts toward a student's denominator only when **all** hold:

1. It belongs to the same course as the student's link.
2. Check-in has closed (CHECK_IN_CLOSED or ENDED). Open sessions show as "In progress" and are not counted.
3. It started inside the student's eligibility window: from the earlier of the link's creation and the
   class-list entry's creation, until the entry was retired — **or** the student has a PRESENT record in it.
   Earlier sessions are "Not counted"; we never assume the student was enrolled before ScanIn knew.

There is no "cancelled" session state today. If one is added, it must be excluded in the view's `counted`.

## Outcomes and the percentage

Per session: CONFIRMED, PROVISIONAL, AWAITING_CONFIRMATION, INVALIDATED, NO_RECORD, IN_PROGRESS, NOT_COUNTED.
Provisional, awaiting-confirmation and invalidated records are **never** promoted to confirmed.
`percent = confirmed / counted sessions` (one decimal), shown only when the class-list match is CONFIRMED and
there is at least one counted session; otherwise `percentReason` says why
(NO_ELIGIBLE_SESSIONS, NOT_CONFIRMED, NOT_MATCHED). Missing records are labelled "No record", not "absent".

## Endpoints

| Who      | Endpoint                                             |
| -------- | ---------------------------------------------------- |
| Student  | `GET /me/courses`, `GET /me/courses/:courseId`       |
| Lecturer | `GET /courses/overview`                              |
| Lecturer | `GET /courses/:courseId/attendance-summary`          |
| Lecturer | `GET /courses/:courseId/students/:linkId/attendance` |

A student asking for a course they have no link to gets the same 404 as for a course that does not exist.
Lecturer endpoints require assignment to the course. Students never receive flags, spot-check results,
headcounts, other students, or why a record is under review. `GET /me/attendance` was removed (it counted
every started session regardless of when the student joined and treated provisional presence as present).

## Known limits / decisions for later

- Password recovery does not exist (only change-password under Account); it needs a backend flow and mail template.
- The lecturer summary loads every row for a course; very large courses may need pagination.
- Migration 0008 must be applied to the live database (it runs on the next deploy's migration step).

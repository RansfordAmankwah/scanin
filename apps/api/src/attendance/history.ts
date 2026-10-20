import type pg from 'pg';
import { notFound, UUID } from '../reviews/errors.js';

/**
 * Course-based attendance history, for students and for lecturers.
 *
 * Every number here is derived from the `course_session_attendance` view (migration 0008), which
 * pairs a student's association with a course ONLY with sessions of that same course, and states
 * the counting rule in one place. Nothing is reconstructed from names, and one course's sessions can
 * never enter another course's totals. See docs/COURSE_ATTENDANCE.md.
 *
 * The distinctions the business rules require are kept, never merged:
 *   CONFIRMED              present, and the student is confirmed against the class list
 *   PROVISIONAL            present, self-reported association (no class list match yet)
 *   AWAITING_CONFIRMATION  present, association under review or refused
 *   INVALIDATED            a lecturer invalidated it
 * Flags are an overlay for lecturers only. Students never see flags, only that a lecturer is
 * reviewing a record.
 */
type Db = Pick<pg.Pool, 'query'>;

export type LinkState = 'PROVISIONAL' | 'REVIEW_REQUIRED' | 'CONFIRMED' | 'REJECTED';
export type Bucket = 'CONFIRMED' | 'PROVISIONAL' | 'REVIEW_REQUIRED' | 'INVALIDATED';
export type Outcome =
  | 'CONFIRMED'
  | 'PROVISIONAL'
  | 'AWAITING_CONFIRMATION'
  | 'INVALIDATED'
  | 'NO_RECORD'
  | 'IN_PROGRESS'
  | 'NOT_COUNTED';

export type PercentReason = 'OK' | 'NO_ELIGIBLE_SESSIONS' | 'NOT_CONFIRMED' | 'NOT_MATCHED';

/** The columns of the view that the arithmetic needs. */
export interface ViewRow {
  link_state: LinkState;
  closed: boolean;
  counted: boolean;
  attendance_id: string | null;
  bucket: Bucket | null;
}

export interface Tally {
  confirmed: number;
  provisional: number;
  awaitingConfirmation: number;
  invalidated: number;
  noRecord: number;
}

export interface Summary {
  /** Sessions that have started in this course (open or closed). */
  sessionsStarted: number;
  /** Sessions counted toward this student's attendance. The denominator. */
  eligibleSessions: number;
  /** Still open for check-in: counted once they close. */
  inProgress: number;
  /** Closed, but before ScanIn knew the student belonged to the course: not counted, not guessed. */
  notCounted: number;
  /** Of the eligible sessions, how each stands. Always adds up to `eligibleSessions`. */
  tally: Tally;
  /** Confirmed attendance as a percentage of eligible sessions, one decimal; null when not defined. */
  percent: number | null;
  percentReason: PercentReason;
}

export function outcomeOf(r: ViewRow): Outcome {
  if (r.attendance_id && r.bucket) {
    return r.bucket === 'REVIEW_REQUIRED' ? 'AWAITING_CONFIRMATION' : r.bucket;
  }
  if (!r.closed) return 'IN_PROGRESS';
  return r.counted ? 'NO_RECORD' : 'NOT_COUNTED';
}

/**
 * The single place attendance arithmetic lives.
 *
 * The percentage is CONFIRMED attendance only. It is shown only when the student is confirmed
 * against the class list, because until then no record can be confirmed, and treating provisional or
 * unresolved attendance as confirmed would be a silent promotion. When it cannot be shown, the
 * reason says why, and the counts are still reported.
 */
export function summarise(rows: ViewRow[], linkState: LinkState): Summary {
  const tally: Tally = {
    confirmed: 0,
    provisional: 0,
    awaitingConfirmation: 0,
    invalidated: 0,
    noRecord: 0,
  };
  let eligible = 0;
  let inProgress = 0;
  let notCounted = 0;
  for (const r of rows) {
    if (!r.closed) inProgress += 1;
    else if (!r.counted) notCounted += 1;
    if (!r.counted) continue;
    eligible += 1;
    const o = outcomeOf(r);
    if (o === 'CONFIRMED') tally.confirmed += 1;
    else if (o === 'PROVISIONAL') tally.provisional += 1;
    else if (o === 'AWAITING_CONFIRMATION') tally.awaitingConfirmation += 1;
    else if (o === 'INVALIDATED') tally.invalidated += 1;
    else tally.noRecord += 1;
  }

  let percent: number | null = null;
  let percentReason: PercentReason = 'OK';
  if (linkState === 'REJECTED') percentReason = 'NOT_MATCHED';
  else if (eligible === 0) percentReason = 'NO_ELIGIBLE_SESSIONS';
  else if (linkState !== 'CONFIRMED') percentReason = 'NOT_CONFIRMED';
  else percent = Math.round((tally.confirmed / eligible) * 1000) / 10;

  return {
    sessionsStarted: rows.length,
    eligibleSessions: eligible,
    inProgress,
    notCounted,
    tally,
    percent,
    percentReason,
  };
}

// --- Queries ------------------------------------------------------------------------------------

interface SessionRow extends ViewRow {
  link_id: string;
  session_id: string;
  session_title: string;
  session_date: string;
  session_state: string;
  attendance_source: 'QR_SCAN' | 'MANUAL' | null;
  flagged: boolean | null;
  eligible_from: Date;
  category: string | null;
  dispute_id: string | null;
  dispute_state: 'OPEN' | 'RESOLVED_UPHELD' | 'RESOLVED_INVALIDATED' | null;
  dispute_opened_at: Date | null;
  dispute_resolved_at: Date | null;
  dispute_replies: number | null;
  verification: string | null;
}

const SESSION_COLUMNS = `
  v.link_id, v.link_state::text AS link_state, v.session_id, v.session_title,
  to_char(v.session_date, 'YYYY-MM-DD') AS session_date, v.session_state::text AS session_state,
  v.closed, v.counted, v.attendance_id, v.attendance_source::text AS attendance_source,
  v.bucket, v.flagged, v.eligible_from,
  (SELECT r.reason_category::text FROM attendance_revisions r
    WHERE r.attendance_id = v.attendance_id AND r.change_kind = 'INVALIDATED'
    ORDER BY r.rev_no DESC LIMIT 1) AS category,
  d.id AS dispute_id, d.state::text AS dispute_state,
  d.opened_at AS dispute_opened_at, d.resolved_at AS dispute_resolved_at,
  (SELECT count(*)::int FROM attendance_dispute_events e
    WHERE e.dispute_id = d.id AND e.kind = 'STUDENT_RESPONSE') AS dispute_replies,
  (SELECT i.state::text FROM spot_check_items i WHERE i.attendance_id = v.attendance_id) AS verification`;

const DISPUTE_JOIN = `
  LEFT JOIN LATERAL (
    SELECT d.id, d.state, d.opened_at, d.resolved_at FROM attendance_disputes d
     WHERE d.attendance_id = v.attendance_id ORDER BY d.opened_at DESC LIMIT 1) d ON true`;

const studentSession = (r: SessionRow) => ({
  id: r.session_id,
  title: r.session_title,
  date: r.session_date,
  phase: r.closed ? ('CLOSED' as const) : ('IN_PROGRESS' as const),
  outcome: outcomeOf(r),
  counted: r.counted,
  source: r.attendance_source,
  /** Only meaningful when the outcome is INVALIDATED. */
  invalidationCategory: r.bucket === 'INVALIDATED' ? r.category : null,
  /** Present only while a lecturer is reviewing, or after they reviewed, this record. */
  review:
    r.dispute_id && r.dispute_state && r.dispute_opened_at
      ? {
          id: r.dispute_id,
          state: r.dispute_state,
          openedAt: r.dispute_opened_at.toISOString(),
          resolvedAt: r.dispute_resolved_at?.toISOString() ?? null,
          repliesLeft: Math.max(0, 5 - (r.dispute_replies ?? 0)),
        }
      : null,
});

interface CourseHeader {
  course_id: string;
  link_id: string;
  link_state: LinkState;
  code: string;
  title: string;
  term_id: string;
  term_name: string;
  starts_on: string;
  ends_on: string;
}

const COURSE_HEADER = `
  SELECT l.course_id, l.id AS link_id, l.state::text AS link_state, co.code, co.title,
         t.id AS term_id, t.name AS term_name,
         to_char(t.starts_on, 'YYYY-MM-DD') AS starts_on, to_char(t.ends_on, 'YYYY-MM-DD') AS ends_on
    FROM roster_links l
    JOIN courses co ON co.id = l.course_id
    JOIN terms t ON t.id = co.term_id`;

const courseOf = (h: CourseHeader) => ({
  id: h.course_id,
  code: h.code,
  title: h.title,
  term: { id: h.term_id, name: h.term_name, startsOn: h.starts_on, endsOn: h.ends_on },
});

/** Every course the signed-in student is associated with, each with its own summary. */
export async function studentCourses(db: Db, studentId: string) {
  const headers = await db.query<CourseHeader>(
    `${COURSE_HEADER} WHERE l.student_id = $1 ORDER BY t.starts_on DESC, co.code`,
    [studentId],
  );
  const rows = await db.query<SessionRow>(
    `SELECT v.course_id, ${SESSION_COLUMNS}
       FROM course_session_attendance v ${DISPUTE_JOIN}
      WHERE v.student_id = $1
      ORDER BY v.session_date DESC, v.started_at DESC`,
    [studentId],
  );
  const byCourse = new Map<string, SessionRow[]>();
  for (const r of rows.rows as Array<SessionRow & { course_id: string }>) {
    byCourse.set(r.course_id, [...(byCourse.get(r.course_id) ?? []), r]);
  }
  return {
    courses: headers.rows.map((h) => {
      const sessions = byCourse.get(h.course_id) ?? [];
      const latest = sessions[0];
      return {
        ...courseOf(h),
        association: { state: h.link_state },
        summary: summarise(sessions, h.link_state),
        latestSession: latest
          ? {
              id: latest.session_id,
              title: latest.session_title,
              date: latest.session_date,
              outcome: outcomeOf(latest),
            }
          : null,
        openReviews: sessions.filter((s) => s.dispute_state === 'OPEN').length,
      };
    }),
  };
}

/**
 * One course's history for the signed-in student. A course the student is not associated with is
 * indistinguishable from one that does not exist.
 */
export async function studentCourseHistory(db: Db, studentId: string, courseId: string) {
  if (!UUID.test(courseId)) throw notFound();
  const header = (
    await db.query<CourseHeader>(`${COURSE_HEADER} WHERE l.student_id = $1 AND l.course_id = $2`, [
      studentId,
      courseId,
    ])
  ).rows[0];
  if (!header) throw notFound();

  const rows = (
    await db.query<SessionRow>(
      `SELECT ${SESSION_COLUMNS}
         FROM course_session_attendance v ${DISPUTE_JOIN}
        WHERE v.student_id = $1 AND v.course_id = $2
        ORDER BY v.session_date DESC, v.started_at DESC`,
      [studentId, courseId],
    )
  ).rows;

  return {
    course: courseOf(header),
    association: { state: header.link_state },
    summary: summarise(rows, header.link_state),
    /** Sessions that started before this moment are not counted: ScanIn did not know the student belonged. */
    countedFrom: rows[0]?.eligible_from.toISOString() ?? null,
    sessions: rows.map(studentSession),
  };
}

// --- Lecturer views -----------------------------------------------------------------------------

/**
 * Cumulative attendance of every student in a course, plus per-session totals. Distinguishes the two
 * questions a lecturer asks: "how did this class go?" (sessions) and "how is this student doing over
 * the term?" (students).
 */
export async function courseAttendanceSummary(db: Db, courseId: string) {
  const links = await db.query<{
    link_id: string;
    link_state: LinkState;
    student_id_display: string;
    full_name: string;
    open_reviews: number;
  }>(
    `SELECT l.id AS link_id, l.state::text AS link_state, u.student_id_display, u.full_name,
            (SELECT count(*)::int FROM attendance_disputes d
              WHERE d.student_id = l.student_id AND d.course_id = l.course_id AND d.state = 'OPEN') AS open_reviews
       FROM roster_links l JOIN users u ON u.id = l.student_id
      WHERE l.course_id = $1 ORDER BY u.student_id_norm`,
    [courseId],
  );
  const rows = await db.query<ViewRow & { link_id: string; flagged: boolean | null }>(
    `SELECT v.link_id, v.link_state::text AS link_state, v.closed, v.counted, v.attendance_id, v.bucket, v.flagged
       FROM course_session_attendance v WHERE v.course_id = $1`,
    [courseId],
  );
  const byLink = new Map<string, Array<ViewRow & { flagged: boolean | null }>>();
  for (const r of rows.rows) byLink.set(r.link_id, [...(byLink.get(r.link_id) ?? []), r]);

  const sessions = await db.query<{
    id: string;
    title: string;
    session_date: string;
    state: string;
    confirmed: number;
    provisional: number;
    awaiting: number;
    invalidated: number;
    flagged: number;
    headcount: number | null;
  }>(
    `SELECT s.id, s.title, to_char(s.session_date, 'YYYY-MM-DD') AS session_date, s.state::text AS state,
            count(*) FILTER (WHERE c.bucket = 'CONFIRMED')::int AS confirmed,
            count(*) FILTER (WHERE c.bucket = 'PROVISIONAL')::int AS provisional,
            count(*) FILTER (WHERE c.bucket = 'REVIEW_REQUIRED')::int AS awaiting,
            count(*) FILTER (WHERE c.bucket = 'INVALIDATED')::int AS invalidated,
            count(*) FILTER (WHERE c.flagged AND c.status = 'PRESENT')::int AS flagged,
            (SELECT h.headcount FROM session_headcounts h WHERE h.session_id = s.id ORDER BY h.rev_no DESC LIMIT 1) AS headcount
       FROM class_sessions s
       LEFT JOIN attendance_classified c ON c.session_id = s.id
      WHERE s.course_id = $1
      GROUP BY s.id
      ORDER BY s.session_date DESC, s.created_at DESC`,
    [courseId],
  );

  const roster = await db.query<{ id: string; student_id_norm: string; full_name: string }>(
    `SELECT e.id, e.student_id_norm, e.full_name FROM roster_entries e
      WHERE e.course_id = $1 AND e.retired_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM roster_links l WHERE l.roster_entry_id = e.id AND l.state <> 'REJECTED')
      ORDER BY e.student_id_norm`,
    [courseId],
  );

  return {
    students: links.rows.map((l) => {
      const own = byLink.get(l.link_id) ?? [];
      return {
        linkId: l.link_id,
        studentId: l.student_id_display,
        fullName: l.full_name,
        associationState: l.link_state,
        summary: summarise(own, l.link_state),
        flaggedRecords: own.filter((r) => r.flagged && r.bucket !== 'INVALIDATED').length,
        openReviews: l.open_reviews,
      };
    }),
    /** On the class list, no account yet: nothing can be recorded for them, so nothing is calculated. */
    notRegistered: roster.rows.map((e) => ({
      entryId: e.id,
      studentId: e.student_id_norm,
      fullName: e.full_name,
    })),
    sessions: sessions.rows.map((s) => ({
      id: s.id,
      title: s.title,
      date: s.session_date,
      state: s.state,
      present: s.confirmed + s.provisional + s.awaiting,
      confirmed: s.confirmed,
      provisional: s.provisional,
      awaitingConfirmation: s.awaiting,
      invalidated: s.invalidated,
      flagged: s.flagged,
      headcount: s.headcount,
    })),
  };
}

/**
 * A single grid for a whole course: one row per student who attended any session, one column per
 * session (headed by the session's own title), and a Present/Absent cell for each. A cell is Present
 * only when a PRESENT record exists for that student and session; invalidated records count as
 * Absent. Students are listed alphabetically; sessions run in chronological order. Columns whose
 * titles collide are disambiguated with the session date.
 */
export async function courseAttendanceMatrix(db: Db, courseId: string) {
  if (!UUID.test(courseId)) throw notFound();
  const head = (
    await db.query<{ code: string; title: string }>(
      `SELECT code, title FROM courses WHERE id = $1`,
      [courseId],
    )
  ).rows[0];
  if (!head) throw notFound();

  const sessions = (
    await db.query<{ id: string; title: string; date: string }>(
      `SELECT id, title, to_char(session_date, 'YYYY-MM-DD') AS date
         FROM class_sessions
        WHERE course_id = $1 AND state <> 'NOT_STARTED'
        ORDER BY session_date, created_at, id`,
      [courseId],
    )
  ).rows;

  const students = (
    await db.query<{ id: string; student_id_display: string; full_name: string }>(
      `SELECT DISTINCT u.id, u.student_id_display, u.full_name
         FROM attendance_records a JOIN users u ON u.id = a.student_id
        WHERE a.course_id = $1
        ORDER BY u.full_name, u.student_id_display`,
      [courseId],
    )
  ).rows;

  const present = (
    await db.query<{ student_id: string; session_id: string }>(
      `SELECT student_id, session_id FROM attendance_records
        WHERE course_id = $1 AND status = 'PRESENT'`,
      [courseId],
    )
  ).rows;
  const presentSet = new Set(present.map((r) => `${r.student_id}:${r.session_id}`));

  const titleCounts = new Map<string, number>();
  for (const s of sessions) titleCounts.set(s.title, (titleCounts.get(s.title) ?? 0) + 1);

  return {
    course: { id: courseId, code: head.code, title: head.title },
    sessions: sessions.map((s) => ({
      id: s.id,
      title: (titleCounts.get(s.title) ?? 0) > 1 ? `${s.title} (${s.date})` : s.title,
      date: s.date,
    })),
    rows: students.map((st) => ({
      studentId: st.student_id_display,
      fullName: st.full_name,
      present: sessions.map((s) => presentSet.has(`${st.id}:${s.id}`)),
    })),
  };
}

/** One student's history across a course's sessions, as a lecturer sees it (flags included). */
export async function courseStudentHistory(db: Db, courseId: string, linkId: string) {
  if (!UUID.test(linkId)) throw notFound();
  const header = (
    await db.query<CourseHeader & { student_id_display: string; full_name: string }>(
      `SELECT u.student_id_display, u.full_name, l.course_id, l.id AS link_id, l.state::text AS link_state,
              co.code, co.title, t.id AS term_id, t.name AS term_name,
              to_char(t.starts_on, 'YYYY-MM-DD') AS starts_on, to_char(t.ends_on, 'YYYY-MM-DD') AS ends_on
         FROM roster_links l
         JOIN users u ON u.id = l.student_id
         JOIN courses co ON co.id = l.course_id
         JOIN terms t ON t.id = co.term_id
        WHERE l.id = $1 AND l.course_id = $2`,
      [linkId, courseId],
    )
  ).rows[0];
  if (!header) throw notFound();

  const rows = (
    await db.query<SessionRow & { attendance_id: string | null }>(
      `SELECT ${SESSION_COLUMNS}
         FROM course_session_attendance v ${DISPUTE_JOIN}
        WHERE v.link_id = $1 AND v.course_id = $2
        ORDER BY v.session_date DESC, v.started_at DESC`,
      [linkId, courseId],
    )
  ).rows;

  return {
    student: {
      linkId,
      studentId: header.student_id_display,
      fullName: header.full_name,
      associationState: header.link_state,
    },
    summary: summarise(rows, header.link_state),
    countedFrom: rows[0]?.eligible_from.toISOString() ?? null,
    sessions: rows.map((r) => ({
      ...studentSession(r),
      attendanceId: r.attendance_id,
      flagged: r.flagged === true && r.bucket !== 'INVALIDATED',
      verification: r.verification,
      disputeState: r.dispute_state,
    })),
  };
}

/** The lecturer's home: for each course, what is happening now and what needs attention. */
export async function lecturerOverview(db: Db, lecturerId: string) {
  const courses = await db.query<{
    id: string;
    code: string;
    title: string;
    term_id: string;
    term_name: string;
    starts_on: string;
    ends_on: string;
  }>(
    `SELECT co.id, co.code, co.title, t.id AS term_id, t.name AS term_name,
            to_char(t.starts_on, 'YYYY-MM-DD') AS starts_on, to_char(t.ends_on, 'YYYY-MM-DD') AS ends_on
       FROM courses co
       JOIN terms t ON t.id = co.term_id
       JOIN lecturer_courses lc ON lc.course_id = co.id
      WHERE lc.lecturer_id = $1 AND lc.ended_at IS NULL
      ORDER BY t.starts_on DESC, co.code`,
    [lecturerId],
  );
  const ids = courses.rows.map((c) => c.id);
  if (ids.length === 0) return { courses: [] };

  const sessions = await db.query<{
    course_id: string;
    id: string;
    title: string;
    session_date: string;
    state: string;
    started_at: Date | null;
    check_in_deadline_text: string | null;
    present: number;
    total: number;
  }>(
    `SELECT s.course_id, s.id, s.title, to_char(s.session_date, 'YYYY-MM-DD') AS session_date,
            s.state::text AS state, s.started_at, s.check_in_deadline::text AS check_in_deadline_text,
            (SELECT count(*)::int FROM attendance_classified c WHERE c.session_id = s.id AND c.status = 'PRESENT') AS present,
            count(*) OVER (PARTITION BY s.course_id)::int AS total
       FROM class_sessions s
      WHERE s.course_id = ANY($1::uuid[])
      ORDER BY s.course_id, s.session_date DESC, s.created_at DESC`,
    [ids],
  );
  const attention = await db.query<{
    course_id: string;
    to_match: number;
    open_flags: number;
    open_reviews: number;
    students: number;
    not_registered: number;
  }>(
    `SELECT co.id AS course_id,
            (SELECT count(*)::int FROM roster_links l WHERE l.course_id = co.id AND l.state = 'REVIEW_REQUIRED') AS to_match,
            (SELECT count(*)::int FROM investigation_flags f WHERE f.course_id = co.id AND f.state IN ('OPEN','UNDER_REVIEW')) AS open_flags,
            (SELECT count(*)::int FROM attendance_disputes d WHERE d.course_id = co.id AND d.state = 'OPEN') AS open_reviews,
            (SELECT count(*)::int FROM roster_links l WHERE l.course_id = co.id AND l.state <> 'REJECTED') AS students,
            (SELECT count(*)::int FROM roster_entries e WHERE e.course_id = co.id AND e.retired_at IS NULL
               AND NOT EXISTS (SELECT 1 FROM roster_links l WHERE l.roster_entry_id = e.id AND l.state <> 'REJECTED')) AS not_registered
       FROM courses co WHERE co.id = ANY($1::uuid[])`,
    [ids],
  );
  const att = new Map(attention.rows.map((a) => [a.course_id, a]));

  return {
    courses: courses.rows.map((c) => {
      const own = sessions.rows.filter((s) => s.course_id === c.id);
      const open = own.find((s) => s.state === 'CHECK_IN_OPEN') ?? null;
      const last = own.find((s) => s.state !== 'NOT_STARTED') ?? null;
      const a = att.get(c.id);
      return {
        id: c.id,
        code: c.code,
        title: c.title,
        term: { id: c.term_id, name: c.term_name, startsOn: c.starts_on, endsOn: c.ends_on },
        sessions: {
          total: own.length,
          started: own.filter((s) => s.state !== 'NOT_STARTED').length,
        },
        openSession: open
          ? {
              id: open.id,
              title: open.title,
              date: open.session_date,
              present: open.present,
              checkInDeadline: open.check_in_deadline_text,
            }
          : null,
        lastSession: last
          ? {
              id: last.id,
              title: last.title,
              date: last.session_date,
              state: last.state,
              present: last.present,
            }
          : null,
        attention: {
          matchesToReview: a?.to_match ?? 0,
          openFlags: a?.open_flags ?? 0,
          openReviews: a?.open_reviews ?? 0,
        },
        students: { registered: a?.students ?? 0, notRegistered: a?.not_registered ?? 0 },
      };
    }),
  };
}

import type pg from 'pg';

type Db = Pick<pg.Pool, 'query'>;

/**
 * Counts for one session. `presentTotal` is confirmed + provisional + reviewRequired; invalidated
 * records are never part of it. `flaggedPresent` is an overlay (present records with an active
 * flag): it is reported separately and must never be added to the others.
 */
export interface SessionCounts {
  presentTotal: number;
  confirmed: number;
  provisional: number;
  reviewRequired: number;
  invalidated: number;
  flaggedPresent: number;
}

export async function sessionCounts(db: Db, sessionId: string): Promise<SessionCounts> {
  const { rows } = await db.query<Record<string, number>>(
    `SELECT count(*) FILTER (WHERE bucket = 'CONFIRMED')::int AS confirmed,
            count(*) FILTER (WHERE bucket = 'PROVISIONAL')::int AS provisional,
            count(*) FILTER (WHERE bucket = 'REVIEW_REQUIRED')::int AS review_required,
            count(*) FILTER (WHERE bucket = 'INVALIDATED')::int AS invalidated,
            count(*) FILTER (WHERE flagged AND status = 'PRESENT')::int AS flagged_present
       FROM attendance_classified WHERE session_id = $1`,
    [sessionId],
  );
  const r = rows[0] ?? {};
  const confirmed = r.confirmed ?? 0;
  const provisional = r.provisional ?? 0;
  const reviewRequired = r.review_required ?? 0;
  return {
    presentTotal: confirmed + provisional + reviewRequired,
    confirmed,
    provisional,
    reviewRequired,
    invalidated: r.invalidated ?? 0,
    flaggedPresent: r.flagged_present ?? 0,
  };
}

export interface RosterRecord {
  attendanceId: string;
  studentId: string;
  fullName: string;
  status: 'PRESENT' | 'INVALIDATED';
  source: 'QR_SCAN' | 'MANUAL';
  associationState: string;
  associationBasis: string | null;
  flagged: boolean;
  flagKinds: string[];
}

export interface NoRecordEntry {
  entryId: string;
  studentId: string;
  fullName: string;
  registered: boolean;
}

/**
 * The session roster. Deliberately carries NO scan times: who attended and in what state is one
 * question, when each scan happened is another (see the separate scan-history view).
 */
export async function sessionRoster(db: Db, courseId: string, sessionId: string) {
  const records = await db.query<{
    attendance_id: string;
    student_id_display: string;
    full_name: string;
    status: 'PRESENT' | 'INVALIDATED';
    source: 'QR_SCAN' | 'MANUAL';
    link_state: string;
    confirmed_basis: string | null;
    flagged: boolean;
    flag_kinds: string[] | null;
  }>(
    `SELECT c.attendance_id, u.student_id_display, u.full_name, c.status::text AS status, c.source::text AS source,
            c.link_state::text AS link_state, c.confirmed_basis::text AS confirmed_basis, c.flagged,
            (SELECT array_agg(DISTINCT f.kind::text ORDER BY f.kind::text) FROM investigation_flags f
              WHERE f.course_id = c.course_id AND f.state IN ('OPEN', 'UNDER_REVIEW')
                AND (f.attendance_id = c.attendance_id OR f.roster_link_id = c.link_id)) AS flag_kinds
       FROM attendance_classified c
       JOIN users u ON u.id = c.student_id
      WHERE c.session_id = $1 AND c.course_id = $2
      ORDER BY u.student_id_norm`,
    [sessionId, courseId],
  );

  // Roster entries with no attendance record in this session. Not called "absent": no record is
  // not a finding about the student.
  const missing = await db.query<{
    id: string;
    student_id_norm: string;
    full_name: string;
    registered: boolean;
  }>(
    `SELECT e.id, e.student_id_norm, e.full_name,
            EXISTS (SELECT 1 FROM users u WHERE u.student_id_norm = e.student_id_norm) AS registered
       FROM roster_entries e
      WHERE e.course_id = $1 AND e.retired_at IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM attendance_records a
            JOIN roster_links l ON l.id = a.link_id
           WHERE a.session_id = $2 AND l.roster_entry_id = e.id)
      ORDER BY e.student_id_norm`,
    [courseId, sessionId],
  );

  return {
    counts: await sessionCounts(db, sessionId),
    records: records.rows.map<RosterRecord>((r) => ({
      attendanceId: r.attendance_id,
      studentId: r.student_id_display,
      fullName: r.full_name,
      status: r.status,
      source: r.source,
      associationState: r.link_state,
      associationBasis: r.confirmed_basis,
      flagged: r.flagged,
      flagKinds: r.flag_kinds ?? [],
    })),
    noRecord: missing.rows.map<NoRecordEntry>((e) => ({
      entryId: e.id,
      studentId: e.student_id_norm,
      fullName: e.full_name,
      registered: e.registered,
    })),
  };
}

export interface ScanFilters {
  /** Matches student ID or name (substring, case-insensitive). */
  student?: string | undefined;
  outcome?: string | undefined;
  limit: number;
  /** Opaque cursor from the previous page. */
  before?: { receivedAt: string; id: string } | undefined;
}

const OUTCOMES = new Set([
  'ACCEPTED',
  'DUPLICATE_EXISTING',
  'REJECTED_TOKEN_EXPIRED',
  'REJECTED_TOKEN_REVOKED',
  'REJECTED_SESSION_NOT_STARTED',
  'REJECTED_SESSION_CLOSED',
  'REJECTED_SESSION_ENDED',
  'REJECTED_DEVICE_REUSED',
]);
export const isScanOutcome = (value: string): boolean => OUTCOMES.has(value);

/**
 * Scan history for one session, newest first. This is the only place individual scan times and
 * network clusters appear. It covers the 90-day scan-metadata window by construction (older rows
 * are purged).
 */
export async function scanHistory(db: Db, sessionId: string, f: ScanFilters) {
  const params: unknown[] = [sessionId];
  const where = ['s.session_id = $1'];
  if (f.student) {
    params.push(`%${f.student.replace(/[%_\\]/g, '\\$&')}%`);
    where.push(
      `(u.student_id_display ILIKE $${params.length} OR u.full_name ILIKE $${params.length})`,
    );
  }
  if (f.outcome) {
    params.push(f.outcome);
    where.push(`s.outcome = $${params.length}::scan_outcome`);
  }
  if (f.before) {
    params.push(f.before.receivedAt, f.before.id);
    where.push(
      `(s.received_at, s.id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`,
    );
  }
  params.push(f.limit + 1);

  const { rows } = await db.query<{
    id: string;
    received_text: string;
    student_id_display: string;
    full_name: string;
    outcome: string;
    ua_family: string | null;
    network: string | null;
  }>(
    `SELECT s.id,
            to_char(s.received_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS received_text,
            u.student_id_display, u.full_name, s.outcome::text AS outcome, s.ua_family,
            -- A short label for the hashed network address: equal labels mean the same address.
            left(encode(s.ip_hash, 'hex'), 8) AS network
       FROM scan_attempts s
       JOIN users u ON u.id = s.student_id
      WHERE ${where.join(' AND ')}
      ORDER BY s.received_at DESC, s.id DESC
      LIMIT $${params.length}`,
    params,
  );

  const page = rows.slice(0, f.limit);
  const last = page.at(-1);
  return {
    scans: page.map((r) => ({
      id: r.id,
      receivedAt: r.received_text,
      studentId: r.student_id_display,
      fullName: r.full_name,
      outcome: r.outcome,
      browser: r.ua_family,
      network: r.network,
    })),
    nextBefore:
      rows.length > f.limit && last ? { receivedAt: last.received_text, id: last.id } : null,
  };
}

/**
 * The signed-in student's own attendance: for each course they are linked to, every session that
 * has started, with their record (or none). Never includes flags, lecturer explanations, scan
 * times or anyone else's data.
 */
export async function studentAttendance(db: Db, studentId: string) {
  const { rows } = await db.query<{
    course_id: string;
    code: string;
    title: string;
    link_state: string;
    session_id: string;
    session_title: string;
    session_date: string;
    status: 'PRESENT' | 'INVALIDATED' | null;
    source: string | null;
    category: string | null;
  }>(
    `SELECT co.id AS course_id, co.code, co.title, l.state::text AS link_state,
            s.id AS session_id, s.title AS session_title, to_char(s.session_date, 'YYYY-MM-DD') AS session_date,
            a.status::text AS status, a.source::text AS source,
            (SELECT r.reason_category::text FROM attendance_revisions r
              WHERE r.attendance_id = a.id AND r.change_kind = 'INVALIDATED'
              ORDER BY r.rev_no DESC LIMIT 1) AS category
       FROM roster_links l
       JOIN courses co ON co.id = l.course_id
       JOIN class_sessions s ON s.course_id = co.id AND s.state <> 'NOT_STARTED'
       LEFT JOIN attendance_records a ON a.session_id = s.id AND a.student_id = l.student_id
      WHERE l.student_id = $1
      ORDER BY co.code, s.session_date DESC, s.created_at DESC`,
    [studentId],
  );

  const courses = new Map<
    string,
    {
      id: string;
      code: string;
      title: string;
      associationState: string;
      sessions: Array<{
        id: string;
        title: string;
        date: string;
        status: 'PRESENT' | 'INVALIDATED' | 'NO_RECORD';
        source: string | null;
        invalidationCategory: string | null;
      }>;
    }
  >();
  for (const r of rows) {
    let course = courses.get(r.course_id);
    if (!course) {
      course = {
        id: r.course_id,
        code: r.code,
        title: r.title,
        associationState: r.link_state,
        sessions: [],
      };
      courses.set(r.course_id, course);
    }
    course.sessions.push({
      id: r.session_id,
      title: r.session_title,
      date: r.session_date,
      status: r.status ?? 'NO_RECORD',
      source: r.source,
      invalidationCategory: r.status === 'INVALIDATED' ? r.category : null,
    });
  }
  return {
    courses: [...courses.values()].map((c) => ({
      ...c,
      presentCount: c.sessions.filter((s) => s.status === 'PRESENT').length,
      sessionCount: c.sessions.length,
    })),
  };
}

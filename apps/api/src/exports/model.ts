import type pg from 'pg';
import { sessionRoster, type SessionCounts } from '../attendance/service.js';

/**
 * One report model feeds every export format, so CSV, XLSX, PDF and DOCX can never disagree about
 * who is listed or what the totals are. It is built from a single read-only snapshot of the
 * database, using the same counting definition as the on-screen views.
 */
export type ReportKind = 'ATTENDANCE' | 'SCAN_HISTORY';

export const DEFINITIONS_VERSION = '1';

export const CAVEAT =
  'Student IDs and names are self-reported. "Confirmed" means matched to the class list or confirmed by a lecturer for this course; it does not verify who held the phone. Provisional and needs-review records are counted as present but are not confirmed.';

export interface ReportMeta {
  reportKind: ReportKind;
  title: string;
  courseCode: string;
  courseTitle: string;
  term: string;
  sessionTitle: string;
  sessionDate: string;
  lecturers: string[];
  generatedAt: string;
  generatedBy: string;
  definitionsVersion: string;
  caveat: string;
}

export interface Table {
  columns: string[];
  rows: string[][];
}

export interface ReportModel {
  meta: ReportMeta;
  /** Present only for attendance reports. */
  totals: SessionCounts | null;
  table: Table;
}

const SOURCE = { QR_SCAN: 'QR scan', MANUAL: 'Marked by lecturer' } as const;
const STATUS = { PRESENT: 'Present', INVALIDATED: 'Invalidated' } as const;
const CATEGORY: Record<string, string> = {
  INCORRECT_ENTRY: 'Incorrect attendance entry',
  CONFIRMED_PROXY: 'Confirmed proxy attendance',
  DUPLICATE_OR_ERRONEOUS: 'Duplicate or erroneous record',
  IDENTITY_ENROLLMENT_MISMATCH: 'Identity/enrollment mismatch',
  OTHER: 'Other',
};
const BASIS: Record<string, string> = {
  ROSTER_ID_MATCH: 'Matched to class list by student ID',
  ROSTER_EMAIL_MATCH: 'Matched to class list by verified e-mail',
  LECTURER_IDENTITY_CONFIRMED: 'Identity confirmed by lecturer',
  LECTURER_ENROLLMENT_CONFIRMED: 'Enrollment confirmed by lecturer',
};
const ASSOCIATION: Record<string, string> = {
  PROVISIONAL: 'Provisional (self-reported)',
  REVIEW_REQUIRED: 'Needs review',
  REJECTED: 'Rejected by lecturer',
};
const OUTCOME: Record<string, string> = {
  ACCEPTED: 'Recorded',
  DUPLICATE_EXISTING: 'Repeat scan',
  REJECTED_TOKEN_EXPIRED: 'Rejected: code expired',
  REJECTED_TOKEN_REVOKED: 'Rejected: code cancelled',
  REJECTED_SESSION_NOT_STARTED: 'Rejected: not started',
  REJECTED_SESSION_CLOSED: 'Rejected: check-in closed',
  REJECTED_SESSION_ENDED: 'Rejected: class ended',
  REJECTED_DEVICE_REUSED: 'Rejected: device already used',
};

export class ReportNotFound extends Error {}

/**
 * Builds the report inside a REPEATABLE READ, read-only transaction: every row and every total
 * comes from the same instant. Nothing is written.
 */
export async function buildReport(
  pool: pg.Pool,
  input: { courseId: string; sessionId: string; kind: ReportKind; actorId: string },
): Promise<ReportModel> {
  const c = await pool.connect();
  try {
    await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');

    const head = await c.query<{
      code: string;
      course_title: string;
      term: string;
      session_title: string;
      session_date: string;
      generated_at: string;
      generated_by: string;
    }>(
      `SELECT co.code, co.title AS course_title, t.name AS term, s.title AS session_title,
              to_char(s.session_date, 'YYYY-MM-DD') AS session_date,
              to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS generated_at,
              (SELECT full_name FROM users WHERE id = $3) AS generated_by
         FROM class_sessions s
         JOIN courses co ON co.id = s.course_id
         JOIN terms t ON t.id = co.term_id
        WHERE s.id = $1 AND s.course_id = $2`,
      [input.sessionId, input.courseId, input.actorId],
    );
    const h = head.rows[0];
    if (!h) throw new ReportNotFound();

    const lecturers = await c.query<{ full_name: string }>(
      `SELECT u.full_name FROM lecturer_courses lc JOIN users u ON u.id = lc.lecturer_id
        WHERE lc.course_id = $1 AND lc.ended_at IS NULL ORDER BY u.full_name`,
      [input.courseId],
    );

    const meta: ReportMeta = {
      reportKind: input.kind,
      title: input.kind === 'ATTENDANCE' ? 'Attendance report' : 'Scan history report',
      courseCode: h.code,
      courseTitle: h.course_title,
      term: h.term,
      sessionTitle: h.session_title,
      sessionDate: h.session_date,
      lecturers: lecturers.rows.map((l) => l.full_name),
      generatedAt: h.generated_at,
      generatedBy: h.generated_by,
      definitionsVersion: DEFINITIONS_VERSION,
      caveat: CAVEAT,
    };

    let model: ReportModel;
    if (input.kind === 'ATTENDANCE') {
      const roster = await sessionRoster(c, input.courseId, input.sessionId);
      const categories = await c.query<{ attendance_id: string; category: string }>(
        `SELECT DISTINCT ON (r.attendance_id) r.attendance_id, r.reason_category::text AS category
           FROM attendance_revisions r JOIN attendance_records a ON a.id = r.attendance_id
          WHERE a.session_id = $1 AND r.change_kind = 'INVALIDATED'
          ORDER BY r.attendance_id, r.rev_no DESC`,
        [input.sessionId],
      );
      const categoryOf = new Map(categories.rows.map((r) => [r.attendance_id, r.category]));
      const rows: string[][] = roster.records.map((r) => [
        r.studentId,
        r.fullName,
        STATUS[r.status],
        SOURCE[r.source],
        r.associationState === 'CONFIRMED'
          ? (BASIS[r.associationBasis ?? ''] ?? 'Confirmed')
          : (ASSOCIATION[r.associationState] ?? r.associationState),
        r.flagged ? 'Yes' : 'No',
        r.status === 'INVALIDATED' ? (CATEGORY[categoryOf.get(r.attendanceId) ?? ''] ?? '') : '',
      ]);
      for (const e of roster.noRecord)
        rows.push([e.studentId, e.fullName, 'No record', '', '', '', '']);
      model = {
        meta,
        totals: roster.counts,
        table: {
          columns: [
            'Student ID',
            'Full name',
            'Attendance',
            'Recorded by',
            'Class-list match',
            'Flagged',
            'Invalidation reason',
          ],
          rows,
        },
      };
    } else {
      const scans = await c.query<{
        received: string;
        student_id_display: string;
        full_name: string;
        outcome: string;
        ua_family: string | null;
        network: string | null;
      }>(
        `SELECT to_char(s.received_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS received,
                u.student_id_display, u.full_name, s.outcome::text AS outcome, s.ua_family,
                left(encode(s.ip_hash, 'hex'), 8) AS network
           FROM scan_attempts s JOIN users u ON u.id = s.student_id
          WHERE s.session_id = $1
          ORDER BY s.received_at, s.id`,
        [input.sessionId],
      );
      model = {
        meta,
        totals: null,
        table: {
          columns: ['Time (UTC)', 'Student ID', 'Full name', 'Result', 'Browser', 'Network'],
          rows: scans.rows.map((r) => [
            r.received,
            r.student_id_display,
            r.full_name,
            OUTCOME[r.outcome] ?? r.outcome,
            r.ua_family ?? '',
            r.network ?? '',
          ]),
        },
      };
    }
    await c.query('COMMIT');
    return model;
  } catch (err) {
    await c.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    c.release();
  }
}

/** Counts as label/value pairs, in a fixed order, for every renderer. */
export function totalsRows(t: SessionCounts): Array<[string, number]> {
  return [
    ['Present (all)', t.presentTotal],
    ['Confirmed', t.confirmed],
    ['Provisional', t.provisional],
    ['Needs review', t.reviewRequired],
    ['Invalidated (not counted as present)', t.invalidated],
    ['Flagged (overlay; included above, not additional)', t.flaggedPresent],
  ];
}

/** Header facts as label/value pairs, in a fixed order, for every renderer. */
export function metaRows(m: ReportMeta): Array<[string, string]> {
  return [
    ['Report', m.title],
    ['Course', `${m.courseCode} ${m.courseTitle}`],
    ['Term', m.term],
    ['Session', m.sessionTitle],
    ['Session date', m.sessionDate],
    ['Lecturer(s)', m.lecturers.join(', ')],
    ['Generated (UTC)', m.generatedAt],
    ['Generated by', m.generatedBy],
    ['Definitions version', m.definitionsVersion],
    ['Note', m.caveat],
  ];
}

export const SAFE_FILENAME = (m: ReportMeta, ext: string, idPart: string): string =>
  `${m.reportKind === 'ATTENDANCE' ? 'attendance' : 'scan-history'}-${m.courseCode}-${m.sessionDate}-${idPart}.${ext}`.replace(
    /[^A-Za-z0-9._-]/g,
    '_',
  );

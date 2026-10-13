import type pg from 'pg';
import { courseRetainUntil, writeAudit } from '../audit.js';
import { isUniqueViolation, withTransaction } from '../db/pool.js';
import { normalizeStudentId } from '../auth/identifiers.js';
import { ensureLink } from '../roster/matching.js';
import { notFound, ReviewError, UUID } from './errors.js';

/**
 * Attendance corrections. Every change appends a revision (previous and new status, actor, server
 * time, reason) and moves the record's status in the same transaction; nothing is overwritten or
 * deleted. The database also refuses a status that does not match the latest revision.
 */
export const INVALIDATION_CATEGORIES = [
  'INCORRECT_ENTRY',
  'CONFIRMED_PROXY',
  'DUPLICATE_OR_ERRONEOUS',
  'IDENTITY_ENROLLMENT_MISMATCH',
  'OTHER',
] as const;
export type InvalidationCategory = (typeof INVALIDATION_CATEGORIES)[number];

interface Locked {
  id: string;
  status: 'PRESENT' | 'INVALIDATED';
  current_rev_no: number;
  student_id: string;
}

async function lockRecord(
  c: pg.PoolClient,
  courseId: string,
  sessionId: string,
  attendanceId: string,
): Promise<Locked> {
  if (!UUID.test(sessionId) || !UUID.test(attendanceId)) throw notFound();
  const { rows } = await c.query<Locked>(
    `SELECT id, status::text AS status, current_rev_no, student_id FROM attendance_records
      WHERE id = $1 AND session_id = $2 AND course_id = $3 FOR UPDATE`,
    [attendanceId, sessionId, courseId],
  );
  const r = rows[0];
  if (!r) throw notFound();
  return r;
}

interface ChangeInput {
  courseId: string;
  sessionId: string;
  attendanceId: string;
  actorId: string;
  explanation: string;
}

interface ChangeSpec {
  kind: 'INVALIDATED' | 'RESTORED';
  from: 'PRESENT' | 'INVALIDATED';
  to: 'PRESENT' | 'INVALIDATED';
  category?: InvalidationCategory;
}

/** The change itself, inside a transaction the caller owns (so related writes can be atomic with it). */
async function changeWithin(c: pg.PoolClient, input: ChangeInput, spec: ChangeSpec) {
  const rec = await lockRecord(c, input.courseId, input.sessionId, input.attendanceId);
  if (rec.status !== spec.from) {
    throw new ReviewError(
      409,
      'INVALID_TRANSITION',
      `This record is already ${rec.status.toLowerCase()}.`,
      { status: rec.status },
    );
  }
  const revNo = rec.current_rev_no + 1;
  await c.query(
    `INSERT INTO attendance_revisions
         (attendance_id, rev_no, change_kind, from_status, to_status, actor_user_id, reason_category, explanation)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      rec.id,
      revNo,
      spec.kind,
      spec.from,
      spec.to,
      input.actorId,
      spec.category ?? null,
      input.explanation.trim(),
    ],
  );
  await c.query(
    'UPDATE attendance_records SET status = $2, current_rev_no = $3 WHERE id = $1 AND current_rev_no = $4',
    [rec.id, spec.to, revNo, rec.current_rev_no],
  );
  await writeAudit(c, {
    class: 'DOMAIN',
    actorType: 'LECTURER',
    actorUserId: input.actorId,
    action: spec.kind === 'INVALIDATED' ? 'ATTENDANCE_INVALIDATED' : 'ATTENDANCE_RESTORED',
    courseId: input.courseId,
    sessionId: input.sessionId,
    entityType: 'attendance_record',
    entityId: rec.id,
    retainUntil: await courseRetainUntil(c, input.courseId),
    summary: {
      from: spec.from,
      to: spec.to,
      ...(spec.category ? { category: spec.category } : {}),
    },
  });
  return { attendanceId: rec.id, status: spec.to, revNo };
}

const change = (pool: pg.Pool, input: ChangeInput, spec: ChangeSpec) =>
  withTransaction(pool, (c) => changeWithin(c, input, spec));

/** Invalidates a record inside the caller's transaction (used when a dispute is resolved that way). */
export const invalidateAttendanceWithin = (
  c: pg.PoolClient,
  input: ChangeInput & { category: InvalidationCategory },
) =>
  changeWithin(c, input, {
    kind: 'INVALIDATED',
    from: 'PRESENT',
    to: 'INVALIDATED',
    category: input.category,
  });

export const invalidateAttendance = (
  pool: pg.Pool,
  input: ChangeInput & { category: InvalidationCategory },
) =>
  change(pool, input, {
    kind: 'INVALIDATED',
    from: 'PRESENT',
    to: 'INVALIDATED',
    category: input.category,
  });

export const restoreAttendance = (pool: pg.Pool, input: ChangeInput) =>
  change(pool, input, { kind: 'RESTORED', from: 'INVALIDATED', to: 'PRESENT' });

/**
 * Marks a REGISTERED student present without a QR scan. The record is clearly a manual one (source,
 * the lecturer who made it, and a mandatory explanation). A student who has not registered cannot
 * be marked: attendance is keyed to an authenticated student account.
 */
export async function markPresentManually(
  pool: pg.Pool,
  input: {
    courseId: string;
    sessionId: string;
    actorId: string;
    studentIdText: string;
    explanation: string;
  },
) {
  if (!UUID.test(input.sessionId)) throw notFound();
  const norm = normalizeStudentId(input.studentIdText);
  try {
    return await withTransaction(pool, async (c) => {
      const session = await c.query<{ state: string }>(
        'SELECT state::text AS state FROM class_sessions WHERE id = $1 AND course_id = $2',
        [input.sessionId, input.courseId],
      );
      if (!session.rows[0]) throw notFound();
      if (session.rows[0].state === 'NOT_STARTED') {
        throw new ReviewError(
          409,
          'SESSION_NOT_STARTED',
          'Start the session before recording attendance.',
        );
      }

      const student = norm
        ? await c.query<{ id: string; student_id_display: string; full_name: string }>(
            `SELECT id, student_id_display, full_name FROM users WHERE student_id_norm = $1 AND role = 'STUDENT' AND status = 'ACTIVE'`,
            [norm],
          )
        : { rows: [] };
      const s = student.rows[0];
      if (!s) {
        throw new ReviewError(
          404,
          'STUDENT_NOT_REGISTERED',
          'That student has not created an account yet, so they cannot be marked present.',
        );
      }

      const existing = await c.query<{ id: string; status: string }>(
        'SELECT id, status::text AS status FROM attendance_records WHERE session_id = $1 AND student_id = $2',
        [input.sessionId, s.id],
      );
      if (existing.rows[0]) {
        throw new ReviewError(
          409,
          'ALREADY_RECORDED',
          'This student already has a record for this session.',
          {
            attendanceId: existing.rows[0].id,
            status: existing.rows[0].status,
          },
        );
      }

      // The usual matching rules apply; marking someone present does not confirm who they are.
      const { link } = await ensureLink(c, input.courseId, s.id);
      const inserted = await c.query<{ id: string }>(
        `INSERT INTO attendance_records (session_id, course_id, student_id, link_id, source, manual_marked_by)
         VALUES ($1, $2, $3, $4, 'MANUAL', $5)
         ON CONFLICT (session_id, student_id) DO NOTHING
         RETURNING id`,
        [input.sessionId, input.courseId, s.id, link.id, input.actorId],
      );
      const id = inserted.rows[0]?.id;
      if (!id)
        throw new ReviewError(
          409,
          'ALREADY_RECORDED',
          'This student already has a record for this session.',
        );
      await c.query(
        `INSERT INTO attendance_revisions (attendance_id, rev_no, change_kind, from_status, to_status, actor_user_id, explanation)
         VALUES ($1, 1, 'CREATED_MANUAL', NULL, 'PRESENT', $2, $3)`,
        [id, input.actorId, input.explanation.trim()],
      );
      await writeAudit(c, {
        class: 'DOMAIN',
        actorType: 'LECTURER',
        actorUserId: input.actorId,
        action: 'ATTENDANCE_MARKED_MANUALLY',
        courseId: input.courseId,
        sessionId: input.sessionId,
        entityType: 'attendance_record',
        entityId: id,
        retainUntil: await courseRetainUntil(c, input.courseId),
        summary: { associationState: link.state },
      });
      return {
        attendanceId: id,
        status: 'PRESENT' as const,
        student: { studentId: s.student_id_display, fullName: s.full_name },
        associationState: link.state,
      };
    });
  } catch (err) {
    if (isUniqueViolation(err))
      throw new ReviewError(
        409,
        'ALREADY_RECORDED',
        'This student already has a record for this session.',
      );
    throw err;
  }
}

export async function attendanceHistory(
  pool: pg.Pool,
  courseId: string,
  sessionId: string,
  attendanceId: string,
) {
  if (!UUID.test(sessionId) || !UUID.test(attendanceId)) throw notFound();
  const rec = await pool.query(
    `SELECT a.status::text AS status, a.source::text AS source, u.student_id_display, u.full_name
       FROM attendance_records a JOIN users u ON u.id = a.student_id
      WHERE a.id = $1 AND a.session_id = $2 AND a.course_id = $3`,
    [attendanceId, sessionId, courseId],
  );
  const r = rec.rows[0];
  if (!r) throw notFound();
  const { rows } = await pool.query(
    `SELECT v.rev_no, v.change_kind::text AS kind, v.from_status::text AS from_status, v.to_status::text AS to_status,
            v.reason_category::text AS category, v.explanation, COALESCE(u.full_name, 'System') AS actor,
            to_char(v.recorded_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS at
       FROM attendance_revisions v LEFT JOIN users u ON u.id = v.actor_user_id
      WHERE v.attendance_id = $1 ORDER BY v.rev_no`,
    [attendanceId],
  );
  return {
    record: {
      status: r.status as string,
      source: r.source as string,
      studentId: r.student_id_display as string,
      fullName: r.full_name as string,
    },
    revisions: rows.map((v) => ({
      revNo: v.rev_no as number,
      kind: v.kind as string,
      fromStatus: v.from_status as string | null,
      toStatus: v.to_status as string,
      category: v.category as string | null,
      explanation: v.explanation as string | null,
      actor: v.actor as string,
      at: v.at as string,
    })),
  };
}

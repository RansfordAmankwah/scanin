import type pg from 'pg';
import { courseRetainUntil, writeAudit } from '../audit.js';
import { withTransaction } from '../db/pool.js';
import {
  INVALIDATION_CATEGORIES,
  invalidateAttendanceWithin,
  type InvalidationCategory,
} from '../reviews/corrections.js';
import { notFound, ReviewError, UUID } from '../reviews/errors.js';

/**
 * Disputes: a recorded attendance that a lecturer is reviewing, usually because a spot check could
 * not find the student in the room.
 *
 * A dispute is separate from the attendance status. Opening one changes nothing about the record;
 * the student keeps their check-in, and the original check-in time is never touched. The student can
 * add a response. A lecturer closes it with a written reason, either upholding the record or
 * invalidating it (through the normal, audited invalidation, in the same transaction).
 *
 *   OPEN --upheld--------> RESOLVED_UPHELD
 *   OPEN --invalidated---> RESOLVED_INVALIDATED
 * (resolved disputes are final; a later mistake is corrected through attendance restore.)
 */
export const MAX_STUDENT_RESPONSES = 5;

type Db = Pick<pg.Pool, 'query'>;

interface OpenInput {
  courseId: string;
  sessionId: string;
  attendanceId: string;
  studentId: string;
  sourceItemId: string | null;
  actorId: string;
  retainUntil: string;
}

/** Opens a dispute unless the record is already invalidated or already has an open one. */
export async function openDisputeWithin(
  c: pg.PoolClient,
  input: OpenInput,
): Promise<string | null> {
  const rec = await c.query<{ status: string }>(
    'SELECT status::text AS status FROM attendance_records WHERE id = $1 AND session_id = $2 AND course_id = $3 FOR UPDATE',
    [input.attendanceId, input.sessionId, input.courseId],
  );
  if (rec.rows[0]?.status !== 'PRESENT') return null;
  const open = await c.query(
    "SELECT 1 FROM attendance_disputes WHERE attendance_id = $1 AND state = 'OPEN'",
    [input.attendanceId],
  );
  if ((open.rowCount ?? 0) > 0) return null;

  const made = await c.query<{ id: string }>(
    `INSERT INTO attendance_disputes (attendance_id, session_id, course_id, student_id, source_item_id)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [input.attendanceId, input.sessionId, input.courseId, input.studentId, input.sourceItemId],
  );
  const id = made.rows[0]?.id as string;
  await c.query(
    `INSERT INTO attendance_dispute_events (dispute_id, event_no, kind, to_state, actor_user_id)
     VALUES ($1, 1, 'OPENED', 'OPEN', $2)`,
    [id, input.actorId],
  );
  await writeAudit(c, {
    class: 'DOMAIN',
    actorType: 'LECTURER',
    actorUserId: input.actorId,
    action: 'DISPUTE_OPENED',
    courseId: input.courseId,
    sessionId: input.sessionId,
    entityType: 'attendance_dispute',
    entityId: id,
    retainUntil: input.retainUntil,
    summary: { attendanceId: input.attendanceId, sourceItemId: input.sourceItemId },
  });
  return id;
}

/** A spot check that found "not present" was corrected to verified: that dispute is upheld. */
export async function resolveUpheldBySpotCheckWithin(
  c: pg.PoolClient,
  input: {
    courseId: string;
    sessionId: string;
    sourceItemId: string;
    actorId: string;
    note: string;
    retainUntil: string;
  },
): Promise<void> {
  const open = await c.query<{ id: string; current_event_no: number }>(
    `SELECT id, current_event_no FROM attendance_disputes
      WHERE source_item_id = $1 AND state = 'OPEN' FOR UPDATE`,
    [input.sourceItemId],
  );
  const dispute = open.rows[0];
  if (!dispute) return;
  await closeWithin(
    c,
    dispute.id,
    dispute.current_event_no,
    'RESOLVED_UPHELD',
    input.actorId,
    input.note,
  );
  await writeAudit(c, {
    class: 'DOMAIN',
    actorType: 'LECTURER',
    actorUserId: input.actorId,
    action: 'DISPUTE_RESOLVED',
    courseId: input.courseId,
    sessionId: input.sessionId,
    entityType: 'attendance_dispute',
    entityId: dispute.id,
    retainUntil: input.retainUntil,
    summary: { resolution: 'UPHELD', automatic: true },
  });
}

async function closeWithin(
  c: pg.PoolClient,
  disputeId: string,
  currentEventNo: number,
  to: 'RESOLVED_UPHELD' | 'RESOLVED_INVALIDATED',
  actorId: string,
  note: string,
): Promise<void> {
  const eventNo = currentEventNo + 1;
  await c.query(
    `INSERT INTO attendance_dispute_events (dispute_id, event_no, kind, to_state, actor_user_id, note)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [disputeId, eventNo, to, to, actorId, note],
  );
  await c.query(
    `UPDATE attendance_disputes
        SET state = $2, current_event_no = $3, resolved_at = clock_timestamp(), resolved_by = $4
      WHERE id = $1 AND state = 'OPEN'`,
    [disputeId, to, eventNo, actorId],
  );
}

export async function listDisputes(db: Db, courseId: string, sessionId: string) {
  if (!UUID.test(sessionId)) throw notFound();
  const exists = await db.query('SELECT 1 FROM class_sessions WHERE id = $1 AND course_id = $2', [
    sessionId,
    courseId,
  ]);
  if (exists.rowCount === 0) throw notFound();

  const disputes = await db.query<{
    id: string;
    attendance_id: string;
    student_id_display: string;
    full_name: string;
    state: string;
    attendance_status: string;
    opened_at: Date;
    resolved_at: Date | null;
    source_item_id: string | null;
  }>(
    `SELECT d.id, d.attendance_id, u.student_id_display, u.full_name, d.state::text AS state,
            a.status::text AS attendance_status, d.opened_at, d.resolved_at, d.source_item_id
       FROM attendance_disputes d
       JOIN users u ON u.id = d.student_id
       JOIN attendance_records a ON a.id = d.attendance_id
      WHERE d.session_id = $1 AND d.course_id = $2
      ORDER BY (d.state = 'OPEN') DESC, d.opened_at`,
    [sessionId, courseId],
  );
  const events = await db.query<{
    dispute_id: string;
    event_no: number;
    kind: string;
    note: string | null;
    at: Date;
    by: string;
    role: string;
  }>(
    `SELECT e.dispute_id, e.event_no, e.kind::text AS kind, e.note, e.at, u.full_name AS by, u.role::text AS role
       FROM attendance_dispute_events e
       JOIN attendance_disputes d ON d.id = e.dispute_id
       JOIN users u ON u.id = e.actor_user_id
      WHERE d.session_id = $1 AND d.course_id = $2 ORDER BY e.dispute_id, e.event_no`,
    [sessionId, courseId],
  );
  const byDispute = new Map<string, Array<(typeof events.rows)[number]>>();
  for (const e of events.rows)
    byDispute.set(e.dispute_id, [...(byDispute.get(e.dispute_id) ?? []), e]);

  return {
    disputes: disputes.rows.map((d) => ({
      id: d.id,
      attendanceId: d.attendance_id,
      studentId: d.student_id_display,
      fullName: d.full_name,
      state: d.state,
      attendanceStatus: d.attendance_status,
      openedAt: d.opened_at.toISOString(),
      resolvedAt: d.resolved_at?.toISOString() ?? null,
      fromSpotCheck: d.source_item_id !== null,
      events: (byDispute.get(d.id) ?? []).map((e) => ({
        eventNo: e.event_no,
        kind: e.kind,
        note: e.note,
        at: e.at.toISOString(),
        by: e.by,
        byRole: e.role,
      })),
    })),
  };
}

export async function resolveDispute(
  pool: pg.Pool,
  input: {
    courseId: string;
    sessionId: string;
    disputeId: string;
    actorId: string;
    resolution: 'UPHOLD' | 'INVALIDATE';
    category?: InvalidationCategory;
    explanation: string;
  },
) {
  if (!UUID.test(input.disputeId) || !UUID.test(input.sessionId)) throw notFound();
  if (
    input.resolution === 'INVALIDATE' &&
    !(INVALIDATION_CATEGORIES as readonly string[]).includes(input.category ?? '')
  ) {
    throw new ReviewError(
      400,
      'CATEGORY_REQUIRED',
      'Choose a reason category for invalidating the record.',
    );
  }

  return withTransaction(pool, async (c) => {
    const found = await c.query<{
      id: string;
      state: string;
      current_event_no: number;
      attendance_id: string;
    }>(
      `SELECT id, state::text AS state, current_event_no, attendance_id FROM attendance_disputes
        WHERE id = $1 AND session_id = $2 AND course_id = $3 FOR UPDATE`,
      [input.disputeId, input.sessionId, input.courseId],
    );
    const dispute = found.rows[0];
    if (!dispute) throw notFound();
    if (dispute.state !== 'OPEN') {
      throw new ReviewError(409, 'INVALID_TRANSITION', 'This dispute has already been resolved.', {
        state: dispute.state,
      });
    }

    let attendanceChanged = false;
    if (input.resolution === 'INVALIDATE') {
      const rec = await c.query<{ status: string }>(
        'SELECT status::text AS status FROM attendance_records WHERE id = $1 FOR UPDATE',
        [dispute.attendance_id],
      );
      // Already invalidated by other means: the dispute still closes, with nothing more to change.
      if (rec.rows[0]?.status === 'PRESENT') {
        await invalidateAttendanceWithin(c, {
          courseId: input.courseId,
          sessionId: input.sessionId,
          attendanceId: dispute.attendance_id,
          actorId: input.actorId,
          explanation: input.explanation,
          category: input.category as InvalidationCategory,
        });
        attendanceChanged = true;
      }
    }

    await closeWithin(
      c,
      dispute.id,
      dispute.current_event_no,
      input.resolution === 'UPHOLD' ? 'RESOLVED_UPHELD' : 'RESOLVED_INVALIDATED',
      input.actorId,
      input.explanation.trim(),
    );
    await writeAudit(c, {
      class: 'DOMAIN',
      actorType: 'LECTURER',
      actorUserId: input.actorId,
      action: 'DISPUTE_RESOLVED',
      courseId: input.courseId,
      sessionId: input.sessionId,
      entityType: 'attendance_dispute',
      entityId: dispute.id,
      retainUntil: await courseRetainUntil(c, input.courseId),
      summary: {
        resolution: input.resolution === 'UPHOLD' ? 'UPHELD' : 'INVALIDATED',
        attendanceChanged,
        attendanceId: dispute.attendance_id,
      },
    });
    return {
      disputeId: dispute.id,
      state: input.resolution === 'UPHOLD' ? 'RESOLVED_UPHELD' : 'RESOLVED_INVALIDATED',
      attendanceChanged,
    };
  });
}

/** A student's reply on their own open dispute. Another student's dispute looks like "not found". */
export async function studentRespond(
  pool: pg.Pool,
  input: { studentId: string; disputeId: string; note: string },
) {
  if (!UUID.test(input.disputeId)) throw notFound();
  return withTransaction(pool, async (c) => {
    const found = await c.query<{
      id: string;
      state: string;
      current_event_no: number;
      course_id: string;
      session_id: string;
    }>(
      `SELECT id, state::text AS state, current_event_no, course_id, session_id FROM attendance_disputes
        WHERE id = $1 AND student_id = $2 FOR UPDATE`,
      [input.disputeId, input.studentId],
    );
    const dispute = found.rows[0];
    if (!dispute) throw notFound();
    if (dispute.state !== 'OPEN') {
      throw new ReviewError(409, 'INVALID_TRANSITION', 'This review has already been closed.');
    }
    const used = await c.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM attendance_dispute_events WHERE dispute_id = $1 AND kind = 'STUDENT_RESPONSE'`,
      [dispute.id],
    );
    if ((used.rows[0]?.n ?? 0) >= MAX_STUDENT_RESPONSES) {
      throw new ReviewError(
        409,
        'TOO_MANY_RESPONSES',
        'You have added the most replies allowed. Please speak to your lecturer.',
      );
    }
    const eventNo = dispute.current_event_no + 1;
    await c.query(
      `INSERT INTO attendance_dispute_events (dispute_id, event_no, kind, to_state, actor_user_id, note)
       VALUES ($1, $2, 'STUDENT_RESPONSE', 'OPEN', $3, $4)`,
      [dispute.id, eventNo, input.studentId, input.note.trim()],
    );
    await c.query('UPDATE attendance_disputes SET current_event_no = $2 WHERE id = $1', [
      dispute.id,
      eventNo,
    ]);
    await writeAudit(c, {
      class: 'DOMAIN',
      actorType: 'STUDENT',
      actorUserId: input.studentId,
      action: 'DISPUTE_STUDENT_RESPONDED',
      courseId: dispute.course_id,
      sessionId: dispute.session_id,
      entityType: 'attendance_dispute',
      entityId: dispute.id,
      retainUntil: await courseRetainUntil(c, dispute.course_id),
      summary: { responseNo: (used.rows[0]?.n ?? 0) + 1 },
    });
    return { disputeId: dispute.id, state: 'OPEN' as const };
  });
}

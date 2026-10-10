import type pg from 'pg';
import { courseRetainUntil, writeAudit } from '../audit.js';
import { isUniqueViolation, withTransaction } from '../db/pool.js';
import { notFound, ReviewError, UUID } from './errors.js';

/**
 * Investigation flags are a concern raised about a record or association, with their own
 * lifecycle and history. Raising, reviewing, dismissing or substantiating a flag NEVER changes
 * attendance or an association: a lecturer must make that decision separately.
 */
export type FlagKind = 'PROXY_SUSPECTED' | 'CONFLICTING_STUDENT_ID' | 'AMBIGUOUS_ROSTER_MATCH';
export type FlagState = 'OPEN' | 'UNDER_REVIEW' | 'DISMISSED' | 'SUBSTANTIATED';

const NEXT: Record<FlagState, readonly FlagState[]> = {
  OPEN: ['UNDER_REVIEW'],
  UNDER_REVIEW: ['DISMISSED', 'SUBSTANTIATED'],
  DISMISSED: ['UNDER_REVIEW'], // reopen
  SUBSTANTIATED: ['UNDER_REVIEW'], // reopen
};

export interface RaiseInput {
  courseId: string;
  actorId: string;
  kind: FlagKind;
  attendanceId?: string | undefined;
  linkId?: string | undefined;
  sessionId?: string | undefined;
  note: string;
}

export async function raiseFlag(pool: pg.Pool, input: RaiseInput) {
  if (!input.attendanceId && !input.linkId && !input.sessionId) {
    throw new ReviewError(
      400,
      'SUBJECT_REQUIRED',
      'Say which attendance record, student or session this is about.',
    );
  }
  try {
    return await withTransaction(pool, async (c) => {
      // Every subject must belong to this course.
      if (input.attendanceId) {
        if (!UUID.test(input.attendanceId)) throw notFound();
        const r = await c.query(
          'SELECT 1 FROM attendance_records WHERE id = $1 AND course_id = $2',
          [input.attendanceId, input.courseId],
        );
        if (r.rowCount === 0) throw notFound();
      }
      if (input.linkId) {
        if (!UUID.test(input.linkId)) throw notFound();
        const r = await c.query('SELECT 1 FROM roster_links WHERE id = $1 AND course_id = $2', [
          input.linkId,
          input.courseId,
        ]);
        if (r.rowCount === 0) throw notFound();
      }
      if (input.sessionId) {
        if (!UUID.test(input.sessionId)) throw notFound();
        const r = await c.query('SELECT 1 FROM class_sessions WHERE id = $1 AND course_id = $2', [
          input.sessionId,
          input.courseId,
        ]);
        if (r.rowCount === 0) throw notFound();
      }

      const { rows } = await c.query<{ id: string }>(
        `INSERT INTO investigation_flags (course_id, session_id, roster_link_id, attendance_id, kind, origin, raised_by)
         VALUES ($1, $2, $3, $4, $5, 'LECTURER', $6) RETURNING id`,
        [
          input.courseId,
          input.sessionId ?? null,
          input.linkId ?? null,
          input.attendanceId ?? null,
          input.kind,
          input.actorId,
        ],
      );
      const id = rows[0]?.id as string;
      await c.query(
        `INSERT INTO investigation_flag_events (flag_id, event_no, from_state, to_state, actor_user_id, note)
         VALUES ($1, 1, NULL, 'OPEN', $2, $3)`,
        [id, input.actorId, input.note.trim()],
      );
      await writeAudit(c, {
        class: 'DOMAIN',
        actorType: 'LECTURER',
        actorUserId: input.actorId,
        action: 'FLAG_RAISED',
        courseId: input.courseId,
        sessionId: input.sessionId ?? null,
        entityType: 'investigation_flag',
        entityId: id,
        retainUntil: await courseRetainUntil(c, input.courseId),
        summary: { kind: input.kind },
      });
      return { flagId: id, state: 'OPEN' as FlagState };
    });
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw new ReviewError(
        409,
        'DUPLICATE_ACTIVE_FLAG',
        'There is already an open flag of this kind for this.',
      );
    }
    throw err;
  }
}

export async function transitionFlag(
  pool: pg.Pool,
  input: {
    courseId: string;
    flagId: string;
    actorId: string;
    to: Exclude<FlagState, 'OPEN'>;
    note: string;
  },
) {
  if (!UUID.test(input.flagId)) throw notFound();
  try {
    return await withTransaction(pool, async (c) => {
      const { rows } = await c.query<{ state: FlagState; current_event_no: number }>(
        'SELECT state, current_event_no FROM investigation_flags WHERE id = $1 AND course_id = $2 FOR UPDATE',
        [input.flagId, input.courseId],
      );
      const flag = rows[0];
      if (!flag) throw notFound();
      if (!NEXT[flag.state].includes(input.to)) {
        throw new ReviewError(
          409,
          'INVALID_TRANSITION',
          `A flag that is ${flag.state} cannot move to ${input.to}.`,
          { state: flag.state },
        );
      }
      // Resolving a flag, or reopening a resolved one, must be explained in writing.
      const resolving = input.to === 'DISMISSED' || input.to === 'SUBSTANTIATED';
      const reopening = flag.state === 'DISMISSED' || flag.state === 'SUBSTANTIATED';
      if ((resolving || reopening) && input.note.trim().length < 10) {
        throw new ReviewError(
          400,
          'NOTE_REQUIRED',
          'Resolving or reopening a flag needs a written note of at least 10 characters.',
        );
      }
      const eventNo = flag.current_event_no + 1;
      await c.query(
        `INSERT INTO investigation_flag_events (flag_id, event_no, from_state, to_state, actor_user_id, note)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [input.flagId, eventNo, flag.state, input.to, input.actorId, input.note.trim()],
      );
      await c.query(
        'UPDATE investigation_flags SET state = $2, current_event_no = $3 WHERE id = $1 AND current_event_no = $4',
        [input.flagId, input.to, eventNo, flag.current_event_no],
      );
      await writeAudit(c, {
        class: 'DOMAIN',
        actorType: 'LECTURER',
        actorUserId: input.actorId,
        action: 'FLAG_TRANSITIONED',
        courseId: input.courseId,
        entityType: 'investigation_flag',
        entityId: input.flagId,
        retainUntil: await courseRetainUntil(c, input.courseId),
        summary: { from: flag.state, to: input.to },
      });
      return { flagId: input.flagId, state: input.to };
    });
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw new ReviewError(
        409,
        'DUPLICATE_ACTIVE_FLAG',
        'Another open flag of this kind already exists for this.',
      );
    }
    throw err;
  }
}

export async function flagHistory(pool: pg.Pool, courseId: string, flagId: string) {
  if (!UUID.test(flagId)) throw notFound();
  const flag = await pool.query<{ kind: string; state: string; origin: string }>(
    'SELECT kind::text AS kind, state::text AS state, origin::text AS origin FROM investigation_flags WHERE id = $1 AND course_id = $2',
    [flagId, courseId],
  );
  const f = flag.rows[0];
  if (!f) throw notFound();
  const { rows } = await pool.query(
    `SELECT e.event_no, e.from_state::text AS from_state, e.to_state::text AS to_state, e.note,
            COALESCE(u.full_name, 'System') AS actor,
            to_char(e.at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS at
       FROM investigation_flag_events e LEFT JOIN users u ON u.id = e.actor_user_id
      WHERE e.flag_id = $1 ORDER BY e.event_no`,
    [flagId],
  );
  return {
    flag: { id: flagId, kind: f.kind, state: f.state, origin: f.origin },
    events: rows.map((r) => ({
      eventNo: r.event_no as number,
      fromState: r.from_state as string | null,
      toState: r.to_state as string,
      note: r.note as string | null,
      actor: r.actor as string,
      at: r.at as string,
    })),
  };
}

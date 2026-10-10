import type pg from 'pg';
import { courseRetainUntil, writeAudit } from '../audit.js';
import { withTransaction } from '../db/pool.js';

/**
 * Class-session lifecycle: NOT_STARTED -> CHECK_IN_OPEN -> CHECK_IN_CLOSED -> ENDED.
 *
 * Every transition runs in one transaction that (1) locks the session row FOR UPDATE, (2) reads the
 * database clock AFTER the lock is held, (3) changes state and writes its audit event together.
 * Check-ins (M7) take a shared lock on the same row, so a transition waits for in-flight check-ins
 * and later check-ins see the new state. All times come from the database clock.
 */
export const INITIAL_WINDOW_MINUTES = 30;
/** Provisional sanity cap: a deadline may never be pushed beyond this far ahead of "now". */
export const MAX_DEADLINE_AHEAD_MINUTES = 120;

export class SessionError extends Error {
  constructor(
    readonly status: 400 | 404 | 409,
    readonly code: string,
    message: string,
    readonly state?: string,
  ) {
    super(message);
  }
}

type Client = pg.PoolClient;
type StoredState = 'NOT_STARTED' | 'CHECK_IN_OPEN' | 'CHECK_IN_CLOSED' | 'ENDED';

interface LockedSession {
  id: string;
  state: StoredState;
  /**
   * Deadline and "now" are carried as database text, never as JavaScript Dates: a Date truncates
   * to milliseconds, and the deadline must round-trip exactly (compare-and-swap, extension rows).
   */
  deadlineText: string | null;
  nowText: string;
  /** True when the deadline has passed according to the database clock read after locking. */
  deadlinePassed: boolean;
}

async function lockSession(c: Client, courseId: string, sessionId: string): Promise<LockedSession> {
  const locked = await c.query<{ id: string; state: StoredState; deadline_text: string | null }>(
    `SELECT id, state, check_in_deadline::text AS deadline_text FROM class_sessions
      WHERE id = $1 AND course_id = $2 FOR UPDATE`,
    [sessionId, courseId],
  );
  const row = locked.rows[0];
  if (!row) throw new SessionError(404, 'NOT_FOUND', 'Not found.');
  // Read the clock only now that the lock is held (the wait for it may have been long).
  const clock = await c.query<{ now_text: string; passed: boolean }>(
    `WITH c AS (SELECT clock_timestamp() AS t)
     SELECT c.t::text AS now_text, ($1::timestamptz IS NOT NULL AND c.t >= $1::timestamptz) AS passed FROM c`,
    [row.deadline_text],
  );
  const now = clock.rows[0];
  if (!now) throw new Error('clock read returned no row');
  return {
    id: row.id,
    state: row.state,
    deadlineText: row.deadline_text,
    nowText: now.now_text,
    deadlinePassed: now.passed,
  };
}

/** The state callers should act on: an open session past its deadline is already closed. */
function effectiveState(s: LockedSession): StoredState {
  return s.state === 'CHECK_IN_OPEN' && s.deadlinePassed ? 'CHECK_IN_CLOSED' : s.state;
}

const VIEW_SELECT = `
  SELECT s.id, s.course_id, s.title, to_char(s.session_date, 'YYYY-MM-DD') AS session_date,
         s.state AS stored_state,
         CASE WHEN s.state = 'CHECK_IN_OPEN' AND clock_timestamp() >= s.check_in_deadline
              THEN 'CHECK_IN_CLOSED' ELSE s.state::text END AS state,
         s.started_at, s.check_in_deadline,
         to_char(s.check_in_deadline AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS deadline_text,
         CASE WHEN s.state = 'CHECK_IN_OPEN' AND clock_timestamp() >= s.check_in_deadline
              THEN s.check_in_deadline ELSE s.check_in_closed_at END AS check_in_closed_at,
         s.ended_at, s.created_at
    FROM class_sessions s`;

interface ViewRow {
  id: string;
  course_id: string;
  title: string;
  session_date: string;
  state: StoredState;
  stored_state: StoredState;
  started_at: Date | null;
  check_in_deadline: Date | null;
  /** Microsecond-precision UTC text; round-trips exactly, unlike a JavaScript Date. */
  deadline_text: string | null;
  check_in_closed_at: Date | null;
  ended_at: Date | null;
  created_at: Date;
}

const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);

function present(row: ViewRow, extensions?: ExtensionView[]) {
  return {
    id: row.id,
    courseId: row.course_id,
    title: row.title,
    sessionDate: row.session_date,
    state: row.state,
    startedAt: iso(row.started_at),
    checkInDeadline: row.deadline_text,
    checkInClosedAt: iso(row.check_in_closed_at),
    endedAt: iso(row.ended_at),
    createdAt: row.created_at.toISOString(),
    ...(extensions ? { extensions } : {}),
  };
}

export interface ExtensionView {
  previousDeadline: string;
  newDeadline: string;
  reason: string;
  extendedBy: string;
  createdAt: string;
}

export async function listSessions(pool: pg.Pool, courseId: string) {
  const { rows } = await pool.query<ViewRow>(
    `${VIEW_SELECT} WHERE s.course_id = $1 ORDER BY s.session_date DESC, s.created_at DESC`,
    [courseId],
  );
  return rows.map((r) => present(r));
}

export async function getSession(
  pool: Pick<pg.Pool, 'query'>,
  courseId: string,
  sessionId: string,
) {
  const { rows } = await pool.query<ViewRow>(
    `${VIEW_SELECT} WHERE s.id = $1 AND s.course_id = $2`,
    [sessionId, courseId],
  );
  const row = rows[0];
  if (!row) throw new SessionError(404, 'NOT_FOUND', 'Not found.');
  const ext = await pool.query<{
    previous_deadline: Date;
    new_deadline: Date;
    reason: string;
    extended_by: string;
    created_at: Date;
  }>(
    `SELECT previous_deadline, new_deadline, reason, extended_by, created_at
       FROM session_extensions WHERE session_id = $1 ORDER BY created_at, new_deadline`,
    [sessionId],
  );
  return present(
    row,
    ext.rows.map((e) => ({
      previousDeadline: e.previous_deadline.toISOString(),
      newDeadline: e.new_deadline.toISOString(),
      reason: e.reason,
      extendedBy: e.extended_by,
      createdAt: e.created_at.toISOString(),
    })),
  );
}

export async function createSession(
  pool: pg.Pool,
  input: { courseId: string; actorId: string; title: string; sessionDate?: string | undefined },
) {
  const id = await withTransaction(pool, async (c) => {
    const { rows } = await c.query<{ id: string }>(
      `INSERT INTO class_sessions (course_id, created_by, title, session_date)
       VALUES ($1, $2, $3, COALESCE($4::date, current_date)) RETURNING id`,
      [input.courseId, input.actorId, input.title.trim(), input.sessionDate ?? null],
    );
    const sessionId = rows[0]?.id as string;
    await writeAudit(c, {
      class: 'DOMAIN',
      actorType: 'LECTURER',
      actorUserId: input.actorId,
      action: 'SESSION_CREATED',
      courseId: input.courseId,
      sessionId,
      entityType: 'class_session',
      entityId: sessionId,
      retainUntil: await courseRetainUntil(c, input.courseId),
    });
    return sessionId;
  });
  return getSession(pool, input.courseId, id);
}

/** NOT_STARTED -> CHECK_IN_OPEN. The deadline is exactly 30 minutes after one database timestamp. */
export async function startSession(
  pool: pg.Pool,
  input: { courseId: string; sessionId: string; actorId: string },
) {
  await withTransaction(pool, async (c) => {
    const s = await lockSession(c, input.courseId, input.sessionId);
    if (s.state !== 'NOT_STARTED') {
      throw new SessionError(
        409,
        'INVALID_TRANSITION',
        'This session has already been started.',
        effectiveState(s),
      );
    }
    // One timestamp feeds both columns, so the window is exactly INITIAL_WINDOW_MINUTES.
    await c.query(
      `UPDATE class_sessions s
          SET state = 'CHECK_IN_OPEN', started_at = c.t, started_by = $3,
              check_in_deadline = c.t + make_interval(mins => $4)
         FROM (SELECT clock_timestamp() AS t) c
        WHERE s.id = $1 AND s.course_id = $2 AND s.state = 'NOT_STARTED'`,
      [input.sessionId, input.courseId, input.actorId, INITIAL_WINDOW_MINUTES],
    );
    await writeAudit(c, {
      class: 'DOMAIN',
      actorType: 'LECTURER',
      actorUserId: input.actorId,
      action: 'SESSION_STARTED',
      courseId: input.courseId,
      sessionId: input.sessionId,
      entityType: 'class_session',
      entityId: input.sessionId,
      retainUntil: await courseRetainUntil(c, input.courseId),
      summary: { windowMinutes: INITIAL_WINDOW_MINUTES },
    });
  });
  return getSession(pool, input.courseId, input.sessionId);
}

/**
 * Pushes the deadline forward by `minutes` while check-in is still open. Closed or ended sessions
 * are never reopened. Records previous and new deadline, actor, time and reason.
 */
export async function extendSession(
  pool: pg.Pool,
  input: {
    courseId: string;
    sessionId: string;
    actorId: string;
    minutes: number;
    reason: string;
    /** The deadline the lecturer saw (as returned by the API). Stops double-submits stacking. */
    expectedDeadline: string;
  },
) {
  await withTransaction(pool, async (c) => {
    const s = await lockSession(c, input.courseId, input.sessionId);
    const state = effectiveState(s);
    if (state !== 'CHECK_IN_OPEN' || s.deadlineText === null) {
      throw new SessionError(
        409,
        'INVALID_TRANSITION',
        'Check-in is not open, so it cannot be extended.',
        state,
      );
    }
    const bounds = await c.query<{ same: boolean; new_deadline: string; too_far: boolean }>(
      `SELECT $1::timestamptz = $2::timestamptz AS same,
              ($1::timestamptz + make_interval(mins => $3))::text AS new_deadline,
              $1::timestamptz + make_interval(mins => $3) >
                $4::timestamptz + make_interval(mins => $5) AS too_far`,
      [
        s.deadlineText,
        input.expectedDeadline,
        input.minutes,
        s.nowText,
        MAX_DEADLINE_AHEAD_MINUTES,
      ],
    );
    const next = bounds.rows[0];
    if (!next) throw new Error('deadline arithmetic returned no row');
    if (!next.same) {
      throw new SessionError(
        409,
        'STALE_DEADLINE',
        'The deadline has changed. Refresh and try again.',
        state,
      );
    }
    if (next.too_far) {
      throw new SessionError(
        400,
        'EXTENSION_TOO_FAR',
        `The deadline cannot be more than ${MAX_DEADLINE_AHEAD_MINUTES} minutes from now.`,
      );
    }

    await c.query(
      `INSERT INTO session_extensions (session_id, extended_by, previous_deadline, new_deadline, reason)
       VALUES ($1, $2, $3::timestamptz, $4::timestamptz, $5)`,
      [input.sessionId, input.actorId, s.deadlineText, next.new_deadline, input.reason.trim()],
    );
    const updated = await c.query(
      `UPDATE class_sessions SET check_in_deadline = $3::timestamptz
        WHERE id = $1 AND state = 'CHECK_IN_OPEN' AND check_in_deadline = $2::timestamptz`,
      [input.sessionId, s.deadlineText, next.new_deadline],
    );
    if (updated.rowCount !== 1)
      throw new SessionError(409, 'CONFLICT', 'The session changed. Try again.');

    await writeAudit(c, {
      class: 'DOMAIN',
      actorType: 'LECTURER',
      actorUserId: input.actorId,
      action: 'SESSION_EXTENDED',
      courseId: input.courseId,
      sessionId: input.sessionId,
      entityType: 'class_session',
      entityId: input.sessionId,
      retainUntil: await courseRetainUntil(c, input.courseId),
      summary: {
        previousDeadline: s.deadlineText,
        newDeadline: next.new_deadline,
        minutes: input.minutes,
      },
    });
  });
  return getSession(pool, input.courseId, input.sessionId);
}

/**
 * Ends the session; terminal. If the window already closed by deadline, that remains the close
 * time. Ending an ended session changes nothing and records nothing.
 */
export async function endSession(
  pool: pg.Pool,
  input: { courseId: string; sessionId: string; actorId: string },
) {
  await withTransaction(pool, async (c) => {
    const s = await lockSession(c, input.courseId, input.sessionId);
    if (s.state === 'ENDED') return; // idempotent
    if (s.state === 'NOT_STARTED') {
      throw new SessionError(
        409,
        'INVALID_TRANSITION',
        'A session that has not started cannot be ended.',
        s.state,
      );
    }
    const deadlinePassed = s.state === 'CHECK_IN_OPEN' && s.deadlinePassed;
    const closing = s.state === 'CHECK_IN_OPEN';

    await c.query(
      `UPDATE class_sessions s
          SET state = 'ENDED', ended_at = c.t, ended_by = $3,
              check_in_closed_at = CASE WHEN $4::boolean THEN COALESCE(s.check_in_closed_at, CASE WHEN $5::boolean THEN s.check_in_deadline ELSE c.t END)
                                        ELSE s.check_in_closed_at END,
              check_in_closed_reason = CASE WHEN $4::boolean THEN CASE WHEN $5::boolean THEN 'DEADLINE'::close_reason ELSE 'ENDED_BY_LECTURER'::close_reason END
                                            ELSE s.check_in_closed_reason END
         FROM (SELECT clock_timestamp() AS t) c
        WHERE s.id = $1 AND s.course_id = $2 AND s.state IN ('CHECK_IN_OPEN', 'CHECK_IN_CLOSED')`,
      [input.sessionId, input.courseId, input.actorId, closing, deadlinePassed],
    );
    await writeAudit(c, {
      class: 'DOMAIN',
      actorType: 'LECTURER',
      actorUserId: input.actorId,
      action: 'SESSION_ENDED',
      courseId: input.courseId,
      sessionId: input.sessionId,
      entityType: 'class_session',
      entityId: input.sessionId,
      retainUntil: await courseRetainUntil(c, input.courseId),
      summary: { from: effectiveState(s) },
    });
  });
  return getSession(pool, input.courseId, input.sessionId);
}

/**
 * Materialises deadline closures: CHECK_IN_OPEN sessions whose deadline has passed become
 * CHECK_IN_CLOSED, with the close time set to the deadline itself (not to when this job ran).
 * Correctness never depends on this job (readers and check-ins compare against the deadline); it
 * only keeps stored state tidy. Safe to run on several instances at once.
 */
export async function closeExpiredSessions(pool: pg.Pool, batchSize = 100): Promise<number> {
  return withTransaction(pool, async (c) => {
    const { rows } = await c.query<{ id: string; course_id: string }>(
      `SELECT id, course_id FROM class_sessions
        WHERE state = 'CHECK_IN_OPEN' AND check_in_deadline <= clock_timestamp()
        ORDER BY check_in_deadline
        LIMIT $1
        FOR UPDATE SKIP LOCKED`,
      [batchSize],
    );
    let closed = 0;
    for (const row of rows) {
      // Re-check under the lock: an extension may have committed first.
      const result = await c.query(
        `UPDATE class_sessions
            SET state = 'CHECK_IN_CLOSED', check_in_closed_at = check_in_deadline,
                check_in_closed_reason = 'DEADLINE'
          WHERE id = $1 AND state = 'CHECK_IN_OPEN' AND check_in_deadline <= clock_timestamp()`,
        [row.id],
      );
      if (result.rowCount === 1) {
        closed += 1;
        await writeAudit(c, {
          class: 'DOMAIN',
          actorType: 'SYSTEM',
          action: 'SESSION_CHECKIN_CLOSED',
          courseId: row.course_id,
          sessionId: row.id,
          entityType: 'class_session',
          entityId: row.id,
          retainUntil: await courseRetainUntil(c, row.course_id),
          summary: { reason: 'DEADLINE' },
        });
      }
    }
    return closed;
  });
}

/** Runs the deadline closer on an interval. Returns a function that stops it. */
export function startSessionSweeper(
  pool: pg.Pool,
  onError: (err: unknown) => void,
  intervalMs = 15_000,
): () => void {
  let running = false;
  const timer = setInterval(() => {
    if (running) return;
    running = true;
    closeExpiredSessions(pool)
      .catch(onError)
      .finally(() => {
        running = false;
      });
  }, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}

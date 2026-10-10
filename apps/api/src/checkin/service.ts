import type pg from 'pg';
import { isTransientDbError, withRetry } from '../db/pool.js';
import type { TokenPayload } from '../qr/token.js';
import { sessionLockKey } from '../sessions/service.js';
import { checkTokenTimes } from '../qr/token.js';
import { ensureLink, type LinkState } from '../roster/matching.js';

/**
 * The check-in transaction. Why it is safe:
 *
 *  - It takes SHARED locks on the session (a fair advisory lock, then the row) and holds them to commit. Many check-ins share it
 *    without blocking each other. Ending, closing or extending a session needs an EXCLUSIVE lock,
 *    so it waits for every in-flight check-in to commit, and later check-ins re-read the new state.
 *    Hence no check-in is accepted after the closing transaction commits.
 *  - "Now" is read from the database clock AFTER the lock is held, never from the app or the client.
 *  - One attendance row per (session, student) is a UNIQUE constraint; INSERT ... ON CONFLICT DO
 *    NOTHING makes concurrent and repeated scans collapse into one record.
 *  - The attendance row, its first revision, the roster link, and the scan record commit together.
 *  - Rejected attempts commit only a scan record, never attendance.
 *  - Transient database failures retry the whole transaction; the natural key and the client's
 *    attempt id make a retry (or a retry after a lost response) return the original result.
 */
export interface CheckInInput {
  studentId: string;
  token: TokenPayload;
  clientAttemptId: string;
  ipHash: Buffer | null;
  userAgentFamily: string | null;
}

export type RejectionReason =
  | 'CODE_EXPIRED'
  | 'CODE_REVOKED'
  | 'INVALID_CODE'
  | 'SESSION_NOT_STARTED'
  | 'SESSION_CLOSED'
  | 'SESSION_ENDED';

export interface RecordedResult {
  kind: 'RECORDED' | 'ALREADY_RECORDED';
  /** PRESENT normally; INVALIDATED if a lecturer later invalidated the record. */
  attendanceStatus: 'PRESENT' | 'INVALIDATED';
  /** The student's own association with the course. Never includes flags or lecturer notes. */
  associationState: LinkState;
  course: { code: string; title: string };
  sessionTitle: string;
}

export type CheckInResult = RecordedResult | { kind: 'REJECTED'; reason: RejectionReason };

type Client = pg.PoolClient;

const OUTCOME_FOR_REASON = {
  CODE_EXPIRED: 'REJECTED_TOKEN_EXPIRED',
  CODE_REVOKED: 'REJECTED_TOKEN_REVOKED',
  SESSION_NOT_STARTED: 'REJECTED_SESSION_NOT_STARTED',
  SESSION_CLOSED: 'REJECTED_SESSION_CLOSED',
  SESSION_ENDED: 'REJECTED_SESSION_ENDED',
} as const;

const REASON_FOR_OUTCOME: Record<string, RejectionReason> = {
  REJECTED_TOKEN_EXPIRED: 'CODE_EXPIRED',
  REJECTED_TOKEN_REVOKED: 'CODE_REVOKED',
  REJECTED_SESSION_NOT_STARTED: 'SESSION_NOT_STARTED',
  REJECTED_SESSION_CLOSED: 'SESSION_CLOSED',
  REJECTED_SESSION_ENDED: 'SESSION_ENDED',
};

async function logAttempt(
  c: Client,
  input: CheckInInput,
  outcome: string,
  attendanceId: string | null,
): Promise<void> {
  await c.query(
    `INSERT INTO scan_attempts
       (session_id, student_id, client_attempt_id, token_jti, token_kid, outcome, attendance_id, ip_hash, ua_family)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (student_id, client_attempt_id) DO NOTHING`,
    [
      input.token.sessionId,
      input.studentId,
      input.clientAttemptId,
      input.token.jti,
      input.token.kid,
      outcome,
      attendanceId,
      input.ipHash,
      input.userAgentFamily,
    ],
  );
}

async function presentRecord(
  c: Client,
  attendanceId: string,
): Promise<Omit<RecordedResult, 'kind'>> {
  const { rows } = await c.query<{
    status: 'PRESENT' | 'INVALIDATED';
    link_state: LinkState;
    code: string;
    title: string;
    session_title: string;
  }>(
    `SELECT a.status, l.state AS link_state, co.code, co.title, s.title AS session_title
       FROM attendance_records a
       JOIN roster_links l ON l.id = a.link_id
       JOIN class_sessions s ON s.id = a.session_id
       JOIN courses co ON co.id = a.course_id
      WHERE a.id = $1`,
    [attendanceId],
  );
  const r = rows[0];
  if (!r) throw new Error('attendance record vanished');
  return {
    attendanceStatus: r.status,
    associationState: r.link_state,
    course: { code: r.code, title: r.title },
    sessionTitle: r.session_title,
  };
}

async function attempt(pool: pg.Pool, input: CheckInInput): Promise<CheckInResult> {
  const c = await pool.connect();
  let broken = false;
  try {
    await c.query('BEGIN');
    await c.query("SET LOCAL lock_timeout = '3s'");
    await c.query("SET LOCAL statement_timeout = '5s'");

    // (1) Shared locks on the session: serialise against ending / closing / extending it. The
    // advisory lock is a fair queue (a waiting End holds back newer check-ins instead of being
    // starved by them); the row lock is what the lifecycle changes also take.
    await c.query('SELECT pg_advisory_xact_lock_shared(hashtextextended($1, 0))', [
      sessionLockKey(input.token.sessionId),
    ]);
    const locked = await c.query<{
      course_id: string;
      state: string;
      deadline_text: string | null;
      not_before_ms: string | null;
    }>(
      `SELECT course_id, state::text AS state, check_in_deadline::text AS deadline_text,
              floor(extract(epoch FROM qr_not_before) * 1000)::bigint AS not_before_ms
         FROM class_sessions WHERE id = $1 FOR SHARE`,
      [input.token.sessionId],
    );
    const session = locked.rows[0];
    if (!session) {
      await c.query('ROLLBACK');
      return { kind: 'REJECTED', reason: 'INVALID_CODE' };
    }

    // (2) The decision instant: database time, read only now that the lock is held.
    const clock = await c.query<{ now_ms: string; passed: boolean }>(
      `WITH c AS (SELECT clock_timestamp() AS t)
       SELECT floor(extract(epoch FROM c.t) * 1000)::bigint AS now_ms,
              ($1::timestamptz IS NOT NULL AND c.t >= $1::timestamptz) AS passed
         FROM c`,
      [session.deadline_text],
    );
    const nowMs = Number(clock.rows[0]?.now_ms);
    const deadlinePassed = clock.rows[0]?.passed === true;

    // (3) Replay of an earlier attempt (client retry after a timeout or lost response).
    const earlier = await c.query<{ outcome: string; attendance_id: string | null }>(
      'SELECT outcome::text AS outcome, attendance_id FROM scan_attempts WHERE student_id = $1 AND client_attempt_id = $2',
      [input.studentId, input.clientAttemptId],
    );
    const prior = earlier.rows[0];
    if (prior) {
      if (prior.attendance_id) {
        const view = await presentRecord(c, prior.attendance_id);
        await c.query('COMMIT');
        return { kind: prior.outcome === 'ACCEPTED' ? 'RECORDED' : 'ALREADY_RECORDED', ...view };
      }
      await c.query('COMMIT');
      return { kind: 'REJECTED', reason: REASON_FOR_OUTCOME[prior.outcome] ?? 'INVALID_CODE' };
    }

    // (4) Already recorded for this class? Return that, even if the window has since closed.
    const existing = await c.query<{ id: string }>(
      'SELECT id FROM attendance_records WHERE session_id = $1 AND student_id = $2',
      [input.token.sessionId, input.studentId],
    );
    if (existing.rows[0]) {
      const id = existing.rows[0].id;
      await logAttempt(c, input, 'DUPLICATE_EXISTING', id);
      const view = await presentRecord(c, id);
      await c.query('COMMIT');
      return { kind: 'ALREADY_RECORDED', ...view };
    }

    // (5) Rejections: the code must be current, AND the session must be accepting check-ins.
    // Both are required; a valid signature alone authorises nothing.
    const notBeforeMs = session.not_before_ms === null ? null : Number(session.not_before_ms);
    const times = checkTokenTimes(input.token, nowMs, notBeforeMs);
    let rejection: RejectionReason | null = null;
    if (times === 'EXPIRED') rejection = 'CODE_EXPIRED';
    else if (times === 'REVOKED') rejection = 'CODE_REVOKED';
    else if (times === 'NOT_YET_VALID') rejection = 'INVALID_CODE';
    else if (session.state === 'NOT_STARTED') rejection = 'SESSION_NOT_STARTED';
    else if (session.state === 'ENDED') rejection = 'SESSION_ENDED';
    else if (session.state === 'CHECK_IN_CLOSED' || deadlinePassed) rejection = 'SESSION_CLOSED';

    if (rejection) {
      if (rejection !== 'INVALID_CODE')
        await logAttempt(c, input, OUTCOME_FOR_REASON[rejection], null);
      await c.query('COMMIT'); // commits the scan record only
      return { kind: 'REJECTED', reason: rejection };
    }

    // (6) Accept: roster link, attendance (unique per student and session), first revision, log.
    const { link } = await ensureLink(c, session.course_id, input.studentId);
    const inserted = await c.query<{ id: string }>(
      `INSERT INTO attendance_records (session_id, course_id, student_id, link_id, source)
       VALUES ($1, $2, $3, $4, 'QR_SCAN')
       ON CONFLICT (session_id, student_id) DO NOTHING
       RETURNING id`,
      [input.token.sessionId, session.course_id, input.studentId, link.id],
    );
    let attendanceId = inserted.rows[0]?.id;
    let kind: RecordedResult['kind'] = 'RECORDED';
    if (attendanceId) {
      await c.query(
        `INSERT INTO attendance_revisions (attendance_id, rev_no, change_kind, from_status, to_status, actor_user_id)
         VALUES ($1, 1, 'CREATED_QR', NULL, 'PRESENT', $2)`,
        [attendanceId, input.studentId],
      );
    } else {
      // Lost a race with this same student's other request: theirs is the record.
      const winner = await c.query<{ id: string }>(
        'SELECT id FROM attendance_records WHERE session_id = $1 AND student_id = $2',
        [input.token.sessionId, input.studentId],
      );
      attendanceId = winner.rows[0]?.id as string;
      kind = 'ALREADY_RECORDED';
    }
    await logAttempt(
      c,
      input,
      kind === 'RECORDED' ? 'ACCEPTED' : 'DUPLICATE_EXISTING',
      attendanceId,
    );
    const view = await presentRecord(c, attendanceId);
    await c.query('COMMIT');
    return { kind, ...view };
  } catch (err) {
    // A connection that died mid-transaction must not go back into the pool.
    broken = isTransientDbError(err);
    await c.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    c.release(broken);
  }
}

/** Checks a student in. Retries transient database failures; never reports success before commit. */
export function checkIn(pool: pg.Pool, input: CheckInInput): Promise<CheckInResult> {
  return withRetry(() => attempt(pool, input));
}

import type pg from 'pg';
import { courseRetainUntil, writeAudit } from '../audit.js';
import { sessionCounts } from '../attendance/service.js';
import { withTransaction } from '../db/pool.js';
import { notFound, ReviewError, UUID } from '../reviews/errors.js';

/**
 * Headcount reconciliation: compares the lecturer's count of people physically in the room with the
 * number of students recorded present. A discrepancy is a REVIEW SIGNAL, never proof of anything:
 * students arrive late, step out, or have trouble checking in. Nothing here rejects, invalidates or
 * penalises any attendance record.
 *
 * The status is always computed from the live data, so it follows every check-in, correction and
 * headcount change without any separate "recalculate" step to forget.
 */
export interface ReconciliationSettings {
  tolerancePercent: number;
  toleranceMin: number;
  headcountMax: number;
  staleMinutes: number;
}

export type ReconciliationStatus =
  'NO_HEADCOUNT' | 'CONSISTENT' | 'REVIEW_RECOMMENDED' | 'MORE_PEOPLE_THAN_RECORDS';

/** How much recorded attendance may exceed (or fall short of) the headcount before it is noteworthy. */
export function allowedDifference(headcount: number, s: ReconciliationSettings): number {
  return Math.max(s.toleranceMin, Math.ceil((headcount * s.tolerancePercent) / 100));
}

export function classify(
  headcount: number | null,
  recorded: number,
  s: ReconciliationSettings,
): { status: ReconciliationStatus; difference: number | null; allowed: number | null } {
  if (headcount === null) return { status: 'NO_HEADCOUNT', difference: null, allowed: null };
  const difference = recorded - headcount;
  const allowed = allowedDifference(headcount, s);
  if (difference > allowed) return { status: 'REVIEW_RECOMMENDED', difference, allowed };
  // More people in the room than records is the normal, harmless direction (someone has not
  // scanned yet), so it is reported plainly and never flagged as suspicious.
  if (difference < -allowed) return { status: 'MORE_PEOPLE_THAN_RECORDS', difference, allowed };
  return { status: 'CONSISTENT', difference, allowed };
}

type Db = Pick<pg.Pool, 'query'>;

interface HeadcountRow {
  rev_no: number;
  headcount: number;
  previous_headcount: number | null;
  explanation: string | null;
  recorded_at: Date;
  recorded_by_name: string;
}

const presentHeadcount = (r: HeadcountRow) => ({
  revNo: r.rev_no,
  headcount: r.headcount,
  previousHeadcount: r.previous_headcount,
  explanation: r.explanation,
  recordedAt: r.recorded_at.toISOString(),
  recordedBy: r.recorded_by_name,
});

async function sessionState(db: Db, courseId: string, sessionId: string): Promise<string> {
  if (!UUID.test(sessionId)) throw notFound();
  const { rows } = await db.query<{ state: string }>(
    'SELECT state::text AS state FROM class_sessions WHERE id = $1 AND course_id = $2',
    [sessionId, courseId],
  );
  if (!rows[0]) throw notFound();
  return rows[0].state;
}

export async function getReconciliation(
  db: Db,
  courseId: string,
  sessionId: string,
  settings: ReconciliationSettings,
) {
  const state = await sessionState(db, courseId, sessionId);

  const revisions = await db.query<HeadcountRow>(
    `SELECT h.rev_no, h.headcount, h.previous_headcount, h.explanation, h.recorded_at,
            u.full_name AS recorded_by_name
       FROM session_headcounts h JOIN users u ON u.id = h.recorded_by
      WHERE h.session_id = $1 AND h.course_id = $2
      ORDER BY h.rev_no`,
    [sessionId, courseId],
  );
  const current = revisions.rows.at(-1) ?? null;

  const counts = await sessionCounts(db, sessionId);
  const recorded = counts.presentTotal;
  const { status, difference, allowed } = classify(current?.headcount ?? null, recorded, settings);

  // Stale: the count is old AND people have checked in since it was taken.
  let stale = { isStale: false, checkInsSince: 0, minutesSince: 0 };
  if (current) {
    const since = await db.query<{ n: number; minutes: number }>(
      `SELECT (SELECT count(*) FROM attendance_records a
                WHERE a.session_id = $1 AND a.status = 'PRESENT' AND a.recorded_at > $2)::int AS n,
              floor(extract(epoch FROM (clock_timestamp() - $2::timestamptz)) / 60)::int AS minutes`,
      [sessionId, current.recorded_at],
    );
    const n = since.rows[0]?.n ?? 0;
    const minutes = since.rows[0]?.minutes ?? 0;
    stale = {
      isStale: n > 0 && minutes >= settings.staleMinutes,
      checkInsSince: n,
      minutesSince: minutes,
    };
  }

  const notes = await db.query<{
    note: string;
    status_at_time: string;
    recorded_at: Date;
    by: string;
  }>(
    `SELECT n.note, n.status_at_time, n.recorded_at, u.full_name AS by
       FROM reconciliation_notes n JOIN users u ON u.id = n.recorded_by
      WHERE n.session_id = $1 AND n.course_id = $2
      ORDER BY n.recorded_at DESC LIMIT 10`,
    [sessionId, courseId],
  );

  return {
    sessionState: state,
    headcount: current ? presentHeadcount(current) : null,
    history: revisions.rows.map(presentHeadcount),
    recordedAttendance: recorded,
    invalidated: counts.invalidated,
    difference,
    status,
    tolerance: { percent: settings.tolerancePercent, minimum: settings.toleranceMin, allowed },
    stale,
    notes: notes.rows.map((n) => ({
      note: n.note,
      statusAtTime: n.status_at_time,
      recordedAt: n.recorded_at.toISOString(),
      recordedBy: n.by,
    })),
    limits: { headcountMax: settings.headcountMax },
  };
}

export async function recordHeadcount(
  pool: pg.Pool,
  input: {
    courseId: string;
    sessionId: string;
    actorId: string;
    headcount: number;
    explanation: string | null;
  },
  settings: ReconciliationSettings,
) {
  if (
    !Number.isInteger(input.headcount) ||
    input.headcount < 0 ||
    input.headcount > settings.headcountMax
  ) {
    throw new ReviewError(
      400,
      'INVALID_HEADCOUNT',
      `Enter a whole number from 0 to ${settings.headcountMax}.`,
    );
  }

  const unchanged = await withTransaction(pool, async (c) => {
    // One writer per session at a time, so revision numbers never collide or skip.
    await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
      `headcount:${input.sessionId}`,
    ]);
    const state = await sessionState(c, input.courseId, input.sessionId);
    if (state === 'NOT_STARTED') {
      throw new ReviewError(
        409,
        'SESSION_NOT_STARTED',
        'Start the session before recording a headcount.',
      );
    }

    const before = await c.query<{ rev_no: number; headcount: number }>(
      `SELECT rev_no, headcount FROM session_headcounts WHERE session_id = $1 ORDER BY rev_no DESC LIMIT 1`,
      [input.sessionId],
    );
    const prior = before.rows[0] ?? null;
    if (prior && prior.headcount === input.headcount) return true; // nothing to change, nothing to log

    const recorded = (await sessionCounts(c, input.sessionId)).presentTotal;
    const was = classify(prior?.headcount ?? null, recorded, settings).status;
    const now = classify(input.headcount, recorded, settings);
    const revNo = (prior?.rev_no ?? 0) + 1;

    await c.query(
      `INSERT INTO session_headcounts
         (session_id, course_id, rev_no, headcount, previous_headcount, explanation, recorded_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        input.sessionId,
        input.courseId,
        revNo,
        input.headcount,
        prior?.headcount ?? null,
        input.explanation?.trim() || null,
        input.actorId,
      ],
    );

    const retainUntil = await courseRetainUntil(c, input.courseId);
    const base = {
      class: 'DOMAIN' as const,
      actorType: 'LECTURER' as const,
      actorUserId: input.actorId,
      courseId: input.courseId,
      sessionId: input.sessionId,
      entityType: 'session_headcount',
      retainUntil,
    };
    await writeAudit(c, {
      ...base,
      action: prior ? 'HEADCOUNT_CORRECTED' : 'HEADCOUNT_RECORDED',
      entityId: `${input.sessionId}#${revNo}`,
      summary: {
        revNo,
        previous: prior?.headcount ?? null,
        new: input.headcount,
        ...(input.explanation?.trim() ? { explanation: input.explanation.trim() } : {}),
      },
    });
    if (now.status === 'REVIEW_RECOMMENDED' && was !== 'REVIEW_RECOMMENDED') {
      await writeAudit(c, {
        ...base,
        action: 'RECONCILIATION_FLAGGED',
        entityId: input.sessionId,
        summary: {
          headcount: input.headcount,
          recorded,
          difference: now.difference,
          allowed: now.allowed,
        },
      });
    } else if (was === 'REVIEW_RECOMMENDED' && now.status !== 'REVIEW_RECOMMENDED') {
      await writeAudit(c, {
        ...base,
        action: 'RECONCILIATION_CLEARED',
        entityId: input.sessionId,
        summary: {
          headcount: input.headcount,
          recorded,
          difference: now.difference,
          allowed: now.allowed,
        },
      });
    }
    return false;
  });

  return {
    unchanged,
    reconciliation: await getReconciliation(pool, input.courseId, input.sessionId, settings),
  };
}

/** A lecturer's written response to a flagged discrepancy. Appends to the record; changes nothing else. */
export async function addReconciliationNote(
  pool: pg.Pool,
  input: { courseId: string; sessionId: string; actorId: string; note: string },
  settings: ReconciliationSettings,
) {
  await withTransaction(pool, async (c) => {
    await sessionState(c, input.courseId, input.sessionId);
    const current = await c.query<{ rev_no: number; headcount: number }>(
      `SELECT rev_no, headcount FROM session_headcounts WHERE session_id = $1 ORDER BY rev_no DESC LIMIT 1`,
      [input.sessionId],
    );
    const head = current.rows[0];
    if (!head) {
      throw new ReviewError(
        409,
        'NO_HEADCOUNT',
        'Record a headcount before adding a note about it.',
      );
    }
    const recorded = (await sessionCounts(c, input.sessionId)).presentTotal;
    const { status, difference, allowed } = classify(head.headcount, recorded, settings);
    await c.query(
      `INSERT INTO reconciliation_notes (session_id, course_id, note, status_at_time, headcount_rev, recorded_by)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [input.sessionId, input.courseId, input.note.trim(), status, head.rev_no, input.actorId],
    );
    await writeAudit(c, {
      class: 'DOMAIN',
      actorType: 'LECTURER',
      actorUserId: input.actorId,
      action: 'RECONCILIATION_NOTE_ADDED',
      courseId: input.courseId,
      sessionId: input.sessionId,
      entityType: 'session',
      entityId: input.sessionId,
      retainUntil: await courseRetainUntil(c, input.courseId),
      summary: { statusAtTime: status, difference, allowed, note: input.note.trim() },
    });
  });
  return getReconciliation(pool, input.courseId, input.sessionId, settings);
}

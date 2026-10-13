import { randomInt } from 'node:crypto';
import type pg from 'pg';
import { courseRetainUntil, writeAudit } from '../audit.js';
import { withTransaction } from '../db/pool.js';
import { notFound, ReviewError, UUID } from '../reviews/errors.js';
import { openDisputeWithin, resolveUpheldBySpotCheckWithin } from './disputes.js';

/**
 * Randomised identity spot checks.
 *
 * A lecturer asks for a small sample of students recorded present by QR scan, and then checks in
 * person that each one is really in the room. The sample is random. Two pieces of evidence that
 * already exist in our own data may raise a student's chance of being picked, and each pick records
 * exactly why:
 *
 *   DEVICE_SHARED_FLAG        the system flagged this very check-in because the device had already
 *                             been used for another student in the class (DEVICE_POLICY=FLAG)
 *   PRIOR_NOT_PRESENT_RESULT  an earlier spot check in this course found the student not present,
 *                             and the lecturer did not later uphold that record
 *
 * Shared IP addresses, shared Wi-Fi, a new phone and location are deliberately NOT used: they are
 * normal in a lecture hall. A raised chance is only a chance to be asked to show ID. It never
 * changes anyone's attendance, and a failed check opens a dispute rather than a penalty.
 */
export interface SpotCheckSettings {
  defaultSize: number;
  maxSize: number;
  historySessions: number;
}

export const RISK_FACTORS = ['DEVICE_SHARED_FLAG', 'PRIOR_NOT_PRESENT_RESULT'] as const;
export type RiskFactor = (typeof RISK_FACTORS)[number];

/** Each risk factor doubles the chance, up to four times. Students sampled recently are less likely. */
const RISK_MULTIPLIER = 2;
const MAX_MULTIPLIER = 4;
const RECENTLY_SAMPLED_FACTOR = 0.3;

export type Outcome = 'VERIFIED' | 'NOT_PRESENT' | 'COULD_NOT_VERIFY';
export type ItemState = 'PENDING' | Outcome;
export const METHODS = ['STUDENT_ID_CARD', 'ROSTER_PHOTO', 'OTHER_OFFICIAL_ID'] as const;
export type Method = (typeof METHODS)[number];

/** Which outcome may follow which. The database refuses anything else as well. */
const LEGAL: Record<ItemState, Outcome[]> = {
  PENDING: ['VERIFIED', 'NOT_PRESENT', 'COULD_NOT_VERIFY'],
  COULD_NOT_VERIFY: ['VERIFIED', 'NOT_PRESENT'],
  VERIFIED: ['NOT_PRESENT'], // a correction
  NOT_PRESENT: ['VERIFIED'], // a correction
};

/** A uniform number in (0, 1) from the operating system's secure random source. */
export const secureRandom = (): number => randomInt(1, 2 ** 48) / 2 ** 48;

export interface Candidate {
  attendanceId: string;
  studentId: string;
  factors: RiskFactor[];
  recentlySampled: boolean;
  weight: number;
}

export function weightFor(factors: RiskFactor[], recentlySampled: boolean): number {
  const boost = Math.min(MAX_MULTIPLIER, RISK_MULTIPLIER ** factors.length);
  return boost * (recentlySampled ? RECENTLY_SAMPLED_FACTOR : 1);
}

/**
 * Weighted random sampling without replacement (Efraimidis and Spirakis): each candidate gets the
 * key -ln(u) / weight and the smallest keys win. Equal weights give a plain uniform sample.
 */
export function drawSample(candidates: Candidate[], size: number, rng: () => number): Candidate[] {
  return candidates
    .map((c) => ({ c, key: -Math.log(rng()) / c.weight }))
    .sort((a, b) => a.key - b.key)
    .slice(0, size)
    .map((x) => x.c);
}

async function lockedSession(c: pg.PoolClient, courseId: string, sessionId: string) {
  if (!UUID.test(sessionId)) throw notFound();
  const { rows } = await c.query<{ state: string; created_at: Date }>(
    'SELECT state::text AS state, created_at FROM class_sessions WHERE id = $1 AND course_id = $2',
    [sessionId, courseId],
  );
  const s = rows[0];
  if (!s) throw notFound();
  if (s.state === 'NOT_STARTED') {
    throw new ReviewError(
      409,
      'SESSION_NOT_STARTED',
      'Start the session before running spot checks.',
    );
  }
  return s;
}

type Db = Pick<pg.Pool, 'query'>;

export async function listSpotChecks(
  db: Db,
  courseId: string,
  sessionId: string,
  settings: SpotCheckSettings,
) {
  if (!UUID.test(sessionId)) throw notFound();
  const exists = await db.query('SELECT 1 FROM class_sessions WHERE id = $1 AND course_id = $2', [
    sessionId,
    courseId,
  ]);
  if (exists.rowCount === 0) throw notFound();

  const rounds = await db.query<{
    id: string;
    created_at: Date;
    requested_size: number;
    eligible_count: number;
    selected_count: number;
    by: string;
  }>(
    `SELECT s.id, s.created_at, s.requested_size, s.eligible_count, s.selected_count, u.full_name AS by
       FROM spot_checks s JOIN users u ON u.id = s.created_by
      WHERE s.session_id = $1 AND s.course_id = $2 ORDER BY s.created_at`,
    [sessionId, courseId],
  );
  const items = await db.query<{
    id: string;
    spot_check_id: string;
    attendance_id: string;
    student_id_display: string;
    full_name: string;
    selection_reason: string;
    weight: string;
    risk_factors: RiskFactor[];
    state: ItemState;
    dispute_id: string | null;
    dispute_state: string | null;
  }>(
    `SELECT i.id, i.spot_check_id, i.attendance_id, u.student_id_display, u.full_name,
            i.selection_reason, i.weight::text AS weight, i.risk_factors, i.state::text AS state,
            d.id AS dispute_id, d.state::text AS dispute_state
       FROM spot_check_items i
       JOIN users u ON u.id = i.student_id
       LEFT JOIN LATERAL (
         SELECT d.id, d.state FROM attendance_disputes d
          WHERE d.source_item_id = i.id ORDER BY d.opened_at DESC LIMIT 1) d ON true
      WHERE i.session_id = $1 AND i.course_id = $2
      ORDER BY u.student_id_norm`,
    [sessionId, courseId],
  );
  const events = await db.query<{
    item_id: string;
    event_no: number;
    from_state: ItemState;
    to_state: Outcome;
    method: Method | null;
    explanation: string | null;
    at: Date;
    by: string;
  }>(
    `SELECT e.item_id, e.event_no, e.from_state::text AS from_state, e.to_state::text AS to_state,
            e.method::text AS method, e.explanation, e.at, u.full_name AS by
       FROM spot_check_events e
       JOIN spot_check_items i ON i.id = e.item_id
       JOIN users u ON u.id = e.actor_user_id
      WHERE i.session_id = $1 AND i.course_id = $2 ORDER BY e.item_id, e.event_no`,
    [sessionId, courseId],
  );
  const history = new Map<string, Array<(typeof events.rows)[number]>>();
  for (const e of events.rows) history.set(e.item_id, [...(history.get(e.item_id) ?? []), e]);

  const present = (i: (typeof items.rows)[number]) => ({
    id: i.id,
    attendanceId: i.attendance_id,
    studentId: i.student_id_display,
    fullName: i.full_name,
    selectionReason: i.selection_reason,
    riskFactors: i.risk_factors,
    state: i.state,
    disputeId: i.dispute_id,
    disputeState: i.dispute_state,
    history: (history.get(i.id) ?? []).map((e) => ({
      eventNo: e.event_no,
      from: e.from_state,
      to: e.to_state,
      method: e.method,
      explanation: e.explanation,
      at: e.at.toISOString(),
      by: e.by,
    })),
  });

  const tally = (s: ItemState) => items.rows.filter((i) => i.state === s).length;
  return {
    rounds: rounds.rows.map((r) => ({
      id: r.id,
      createdAt: r.created_at.toISOString(),
      createdBy: r.by,
      requestedSize: r.requested_size,
      eligibleCount: r.eligible_count,
      selectedCount: r.selected_count,
      items: items.rows.filter((i) => i.spot_check_id === r.id).map(present),
    })),
    summary: {
      pending: tally('PENDING'),
      verified: tally('VERIFIED'),
      notPresent: tally('NOT_PRESENT'),
      couldNotVerify: tally('COULD_NOT_VERIFY'),
    },
    limits: { defaultSize: settings.defaultSize, maxSize: settings.maxSize },
  };
}

export async function generateSpotCheck(
  pool: pg.Pool,
  input: {
    courseId: string;
    sessionId: string;
    actorId: string;
    size?: number;
    requestId?: string;
  },
  settings: SpotCheckSettings,
  rng: () => number = secureRandom,
) {
  const size = input.size ?? settings.defaultSize;
  if (!Number.isInteger(size) || size < 1 || size > settings.maxSize) {
    throw new ReviewError(
      400,
      'INVALID_SAMPLE_SIZE',
      `Choose a sample of 1 to ${settings.maxSize} students.`,
    );
  }

  await withTransaction(pool, async (c) => {
    await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
      `spotcheck:${input.sessionId}`,
    ]);
    const session = await lockedSession(c, input.courseId, input.sessionId);

    // The same request, sent twice (double click, retry), is one round.
    if (input.requestId) {
      const again = await c.query(
        'SELECT 1 FROM spot_checks WHERE session_id = $1 AND request_id = $2',
        [input.sessionId, input.requestId],
      );
      if ((again.rowCount ?? 0) > 0) return;
    }

    const recent = await c.query<{ id: string }>(
      `SELECT id FROM class_sessions
        WHERE course_id = $1 AND id <> $2 AND created_at < $3
        ORDER BY created_at DESC LIMIT $4`,
      [input.courseId, input.sessionId, session.created_at, settings.historySessions],
    );

    const rows = await c.query<{
      attendance_id: string;
      student_id: string;
      device_shared: boolean;
      prior_not_present: boolean;
      recently_sampled: boolean;
    }>(
      `SELECT a.id AS attendance_id, a.student_id,
              EXISTS (SELECT 1 FROM investigation_flags f
                       WHERE f.attendance_id = a.id AND f.origin = 'SYSTEM' AND f.kind = 'PROXY_SUSPECTED'
                         AND f.state IN ('OPEN', 'UNDER_REVIEW')) AS device_shared,
              EXISTS (SELECT 1 FROM spot_check_items p
                       WHERE p.student_id = a.student_id AND p.course_id = a.course_id
                         AND p.session_id <> a.session_id AND p.state = 'NOT_PRESENT'
                         AND NOT EXISTS (SELECT 1 FROM attendance_disputes d
                                          WHERE d.source_item_id = p.id AND d.state = 'RESOLVED_UPHELD')) AS prior_not_present,
              EXISTS (SELECT 1 FROM spot_check_items h
                       WHERE h.student_id = a.student_id AND h.session_id = ANY($3::uuid[])) AS recently_sampled
         FROM attendance_records a
        WHERE a.session_id = $1 AND a.course_id = $2
          AND a.status = 'PRESENT' AND a.source = 'QR_SCAN'
          AND NOT EXISTS (SELECT 1 FROM spot_check_items i
                           WHERE i.session_id = a.session_id AND i.student_id = a.student_id)
        ORDER BY a.id`,
      [input.sessionId, input.courseId, recent.rows.map((r) => r.id)],
    );
    if (rows.rows.length === 0) {
      throw new ReviewError(
        409,
        'NO_ELIGIBLE_STUDENTS',
        'There is no one left to check: no students are recorded present by QR scan who have not already been sampled.',
      );
    }

    const candidates: Candidate[] = rows.rows.map((r) => {
      const factors: RiskFactor[] = [];
      if (r.device_shared) factors.push('DEVICE_SHARED_FLAG');
      if (r.prior_not_present) factors.push('PRIOR_NOT_PRESENT_RESULT');
      return {
        attendanceId: r.attendance_id,
        studentId: r.student_id,
        factors,
        recentlySampled: r.recently_sampled,
        weight: weightFor(factors, r.recently_sampled),
      };
    });
    const chosen = drawSample(candidates, size, rng);

    const round = await c.query<{ id: string }>(
      `INSERT INTO spot_checks
         (session_id, course_id, created_by, request_id, requested_size, eligible_count, selected_count, policy)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
      [
        input.sessionId,
        input.courseId,
        input.actorId,
        input.requestId ?? null,
        size,
        candidates.length,
        chosen.length,
        JSON.stringify({
          historySessions: settings.historySessions,
          riskMultiplier: RISK_MULTIPLIER,
          maxMultiplier: MAX_MULTIPLIER,
          recentlySampledFactor: RECENTLY_SAMPLED_FACTOR,
          factors: RISK_FACTORS,
        }),
      ],
    );
    const roundId = round.rows[0]?.id as string;

    const rationale: Array<{
      itemId: string;
      reason: string;
      factors: RiskFactor[];
      weight: number;
    }> = [];
    for (const pick of chosen) {
      const reason = pick.factors.length > 0 ? 'RISK_WEIGHTED' : 'RANDOM';
      const item = await c.query<{ id: string }>(
        `INSERT INTO spot_check_items
           (spot_check_id, session_id, course_id, attendance_id, student_id, selection_reason, weight, risk_factors)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
        [
          roundId,
          input.sessionId,
          input.courseId,
          pick.attendanceId,
          pick.studentId,
          reason,
          pick.weight,
          JSON.stringify(pick.factors),
        ],
      );
      rationale.push({
        itemId: item.rows[0]?.id as string,
        reason,
        factors: pick.factors,
        weight: pick.weight,
      });
    }

    await writeAudit(c, {
      class: 'DOMAIN',
      actorType: 'LECTURER',
      actorUserId: input.actorId,
      action: 'SPOT_CHECK_GENERATED',
      courseId: input.courseId,
      sessionId: input.sessionId,
      entityType: 'spot_check',
      entityId: roundId,
      retainUntil: await courseRetainUntil(c, input.courseId),
      // Item ids and reasons only: the audit trail explains the draw without naming students.
      summary: { requested: size, eligible: candidates.length, selected: chosen.length, rationale },
    });
  });

  return listSpotChecks(pool, input.courseId, input.sessionId, settings);
}

export interface ResultInput {
  courseId: string;
  sessionId: string;
  itemId: string;
  actorId: string;
  requestId: string;
  outcome: Outcome;
  method?: Method | null;
  explanation?: string | null;
}

/**
 * Records one verification outcome. Safe to repeat: the same request id returns the original result
 * instead of recording it again. Illegal transitions are refused, and a negative outcome opens a
 * dispute for a lecturer to review; it never changes the attendance record by itself.
 */
export async function recordSpotCheckResult(
  pool: pg.Pool,
  input: ResultInput,
  settings: SpotCheckSettings,
) {
  const explanation = input.explanation?.trim() || null;
  const method = input.outcome === 'VERIFIED' ? (input.method ?? null) : null;
  if (input.outcome === 'VERIFIED' && !method) {
    throw new ReviewError(
      400,
      'METHOD_REQUIRED',
      'Say how you verified the student (ID card, roster photo or other official ID).',
    );
  }

  await withTransaction(pool, async (c) => {
    if (!UUID.test(input.itemId) || !UUID.test(input.sessionId)) throw notFound();
    const found = await c.query<{
      id: string;
      state: ItemState;
      current_event_no: number | null;
      attendance_id: string;
      student_id: string;
    }>(
      `SELECT id, state::text AS state, current_event_no, attendance_id, student_id
         FROM spot_check_items WHERE id = $1 AND session_id = $2 AND course_id = $3 FOR UPDATE`,
      [input.itemId, input.sessionId, input.courseId],
    );
    const item = found.rows[0];
    if (!item) throw notFound();

    // A retried submission: answer with what was already recorded.
    const replay = await c.query<{ to_state: Outcome; method: Method | null }>(
      'SELECT to_state::text AS to_state, method::text AS method FROM spot_check_events WHERE item_id = $1 AND request_id = $2',
      [item.id, input.requestId],
    );
    if (replay.rows[0]) {
      if (replay.rows[0].to_state !== input.outcome) {
        throw new ReviewError(
          409,
          'REQUEST_ID_REUSED',
          'That request was already used for a different result.',
        );
      }
      return;
    }

    if (!LEGAL[item.state].includes(input.outcome)) {
      throw new ReviewError(
        409,
        'INVALID_TRANSITION',
        item.state === input.outcome
          ? `This check is already recorded as ${input.outcome.toLowerCase().replaceAll('_', ' ')}.`
          : `A check recorded as ${item.state.toLowerCase().replaceAll('_', ' ')} cannot be changed to ${input.outcome.toLowerCase().replaceAll('_', ' ')}.`,
        { state: item.state },
      );
    }
    const correction = item.state === 'VERIFIED' || item.state === 'NOT_PRESENT';
    if ((input.outcome === 'NOT_PRESENT' || correction) && (explanation?.length ?? 0) < 10) {
      throw new ReviewError(
        400,
        'EXPLANATION_REQUIRED',
        'Explain what you found, in at least 10 characters.',
      );
    }

    const eventNo = (item.current_event_no ?? 0) + 1;
    await c.query(
      `INSERT INTO spot_check_events
         (item_id, event_no, from_state, to_state, method, explanation, request_id, actor_user_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        item.id,
        eventNo,
        item.state,
        input.outcome,
        method,
        explanation,
        input.requestId,
        input.actorId,
      ],
    );
    const moved = await c.query(
      `UPDATE spot_check_items SET state = $2, current_event_no = $3
        WHERE id = $1 AND state = $4`,
      [item.id, input.outcome, eventNo, item.state],
    );
    if (moved.rowCount !== 1) {
      throw new ReviewError(
        409,
        'CONFLICT',
        'This check changed while you were recording it. Reload and try again.',
      );
    }

    const retainUntil = await courseRetainUntil(c, input.courseId);
    await writeAudit(c, {
      class: 'DOMAIN',
      actorType: 'LECTURER',
      actorUserId: input.actorId,
      action: 'SPOT_CHECK_RESULT_RECORDED',
      courseId: input.courseId,
      sessionId: input.sessionId,
      entityType: 'spot_check_item',
      entityId: item.id,
      retainUntil,
      summary: {
        from: item.state,
        to: input.outcome,
        correction,
        ...(method ? { method } : {}),
        attendanceId: item.attendance_id,
      },
    });

    if (input.outcome === 'NOT_PRESENT') {
      await openDisputeWithin(c, {
        courseId: input.courseId,
        sessionId: input.sessionId,
        attendanceId: item.attendance_id,
        studentId: item.student_id,
        sourceItemId: item.id,
        actorId: input.actorId,
        retainUntil,
      });
    } else if (input.outcome === 'VERIFIED' && item.state === 'NOT_PRESENT') {
      await resolveUpheldBySpotCheckWithin(c, {
        courseId: input.courseId,
        sessionId: input.sessionId,
        sourceItemId: item.id,
        actorId: input.actorId,
        note: `Spot check corrected to verified: ${explanation}`,
        retainUntil,
      });
    }
  });

  return listSpotChecks(pool, input.courseId, input.sessionId, settings);
}

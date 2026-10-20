import type pg from 'pg';
import { courseRetainUntil, writeAudit } from '../audit.js';
import { isUniqueViolation, withTransaction } from '../db/pool.js';
import { holderOf, type Basis, type LinkRow, type LinkState } from '../roster/matching.js';
import { invalidateAttendanceWithin } from './corrections.js';
import { notFound, ReviewError, UUID } from './errors.js';

/**
 * Lecturer decisions about a student's association with ONE course. Each is a recorded assertion
 * by that lecturer for that course; none verifies identity or enrollment anywhere else, and none
 * touches attendance (attendance is decided separately).
 */
export type LinkDecision = 'CONFIRM' | 'KEEP_PROVISIONAL' | 'REJECT' | 'MARK_REVIEW_REQUIRED';
export type LecturerBasis = Extract<
  Basis,
  'LECTURER_IDENTITY_CONFIRMED' | 'LECTURER_ENROLLMENT_CONFIRMED'
>;

const ALLOWED_FROM: Record<LinkDecision, readonly LinkState[]> = {
  CONFIRM: ['PROVISIONAL', 'REVIEW_REQUIRED', 'REJECTED'],
  KEEP_PROVISIONAL: ['PROVISIONAL', 'REVIEW_REQUIRED'],
  REJECT: ['PROVISIONAL', 'REVIEW_REQUIRED'],
  MARK_REVIEW_REQUIRED: ['PROVISIONAL', 'CONFIRMED', 'REJECTED'],
};

const TARGET: Record<LinkDecision, LinkState> = {
  CONFIRM: 'CONFIRMED',
  KEEP_PROVISIONAL: 'PROVISIONAL',
  REJECT: 'REJECTED',
  MARK_REVIEW_REQUIRED: 'REVIEW_REQUIRED',
};

export interface DecideInput {
  courseId: string;
  linkId: string;
  actorId: string;
  decision: LinkDecision;
  basis?: LecturerBasis | undefined;
  entryId?: string | undefined;
  explanation: string;
  reviewKind?: 'IDENTITY' | 'ENROLLMENT' | undefined;
  flagId?: string | undefined;
}

/** The decision itself, inside a transaction the caller owns (so related writes can be atomic). */
export async function decideLinkWithin(c: pg.PoolClient, input: DecideInput) {
  // Serialise decisions about this link; a second concurrent decision sees the first's result.
  const { rows } = await c.query<LinkRow>(
    `SELECT id, course_id, student_id, roster_entry_id, state, confirmed_basis, current_review_no
           FROM roster_links WHERE id = $1 AND course_id = $2 FOR UPDATE`,
    [input.linkId, input.courseId],
  );
  const link = rows[0];
  if (!link) throw notFound();

  if (!ALLOWED_FROM[input.decision].includes(link.state)) {
    throw new ReviewError(
      409,
      'INVALID_TRANSITION',
      `That decision is not possible while the match is ${link.state}.`,
      {
        state: link.state,
      },
    );
  }
  if (input.decision === 'CONFIRM' && !input.basis) {
    throw new ReviewError(
      400,
      'BASIS_REQUIRED',
      'Say whether you are confirming identity or enrollment.',
    );
  }

  // Which roster entry the link points to afterwards.
  let entryId: string | null = link.roster_entry_id;
  if (input.decision === 'REJECT') entryId = null;
  if (input.decision === 'CONFIRM' && input.entryId) {
    if (!UUID.test(input.entryId))
      throw new ReviewError(400, 'INVALID_ENTRY', 'That class-list entry is not valid.');
    const entry = await c.query(
      'SELECT 1 FROM roster_entries WHERE id = $1 AND course_id = $2 AND retired_at IS NULL',
      [input.entryId, input.courseId],
    );
    if (entry.rowCount === 0)
      throw new ReviewError(400, 'INVALID_ENTRY', 'That class-list entry is not valid.');
    const holder = await holderOf(c, input.entryId);
    if (holder && holder.id !== link.id) {
      throw new ReviewError(
        409,
        'ENTRY_HELD',
        'Another student is linked to that entry. Resolve that match first.',
        {
          heldByLinkId: holder.id,
        },
      );
    }
    entryId = input.entryId;
  }

  if (input.flagId) {
    if (!UUID.test(input.flagId)) throw notFound();
    const flag = await c.query(
      'SELECT 1 FROM investigation_flags WHERE id = $1 AND course_id = $2',
      [input.flagId, input.courseId],
    );
    if (flag.rowCount === 0) throw notFound();
  }

  const toState = TARGET[input.decision];
  const basis: LecturerBasis | null = input.decision === 'CONFIRM' ? (input.basis ?? null) : null;
  const kind =
    input.decision === 'CONFIRM'
      ? basis === 'LECTURER_IDENTITY_CONFIRMED'
        ? 'IDENTITY'
        : 'ENROLLMENT'
      : (input.reviewKind ?? 'ENROLLMENT');
  const reviewNo = link.current_review_no + 1;

  await c.query(
    `INSERT INTO identity_reviews
           (link_id, review_no, review_kind, decision, from_state, to_state, from_entry_id, to_entry_id,
            basis, actor_user_id, explanation, flag_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
    [
      link.id,
      reviewNo,
      kind,
      input.decision,
      link.state,
      toState,
      link.roster_entry_id,
      entryId,
      basis,
      input.actorId,
      input.explanation.trim(),
      input.flagId ?? null,
    ],
  );
  await c.query(
    `UPDATE roster_links
            SET state = $2, confirmed_basis = $3, roster_entry_id = $4, current_review_no = $5
          WHERE id = $1 AND current_review_no = $6`,
    [link.id, toState, basis, entryId, reviewNo, link.current_review_no],
  );
  await writeAudit(c, {
    class: 'DOMAIN',
    actorType: 'LECTURER',
    actorUserId: input.actorId,
    action: 'LINK_DECISION',
    courseId: input.courseId,
    entityType: 'roster_link',
    entityId: link.id,
    retainUntil: await courseRetainUntil(c, input.courseId),
    summary: { decision: input.decision, from: link.state, to: toState, basis },
  });
  return { linkId: link.id, state: toState, basis, entryId, reviewNo };
}

export async function decideLink(pool: pg.Pool, input: DecideInput) {
  try {
    return await withTransaction(pool, (c) => decideLinkWithin(c, input));
  } catch (err) {
    // Two different students racing for the same roster entry: the unique index decides.
    if (isUniqueViolation(err, 'roster_links_entry_holder_key')) {
      throw new ReviewError(
        409,
        'ENTRY_HELD',
        'Another student is linked to that entry. Resolve that match first.',
      );
    }
    throw err;
  }
}

/**
 * "Part of class": adds the student to the class list and confirms the match as enrollment. An entry
 * is created for their self-reported ID and name if one does not already exist (so a roster can grow
 * organically from nothing). One tap; the reason is recorded automatically.
 */
export async function addToClass(
  pool: pg.Pool,
  input: { courseId: string; linkId: string; actorId: string },
) {
  if (!UUID.test(input.linkId)) throw notFound();
  try {
    return await withTransaction(pool, async (c) => {
      const { rows } = await c.query<LinkRow>(
        `SELECT id, course_id, student_id, roster_entry_id, state, confirmed_basis, current_review_no
           FROM roster_links WHERE id = $1 AND course_id = $2 FOR UPDATE`,
        [input.linkId, input.courseId],
      );
      const link = rows[0];
      if (!link) throw notFound();
      if (link.state === 'CONFIRMED') {
        throw new ReviewError(409, 'ALREADY_ON_LIST', 'This student is already on the class list.');
      }

      const s = await c.query<{ student_id_norm: string; full_name: string }>(
        `SELECT student_id_norm, full_name FROM users WHERE id = $1`,
        [link.student_id],
      );
      const student = s.rows[0];
      if (!student?.student_id_norm) throw notFound();

      // Reuse an existing active entry for this ID, or create one (no import: added by a lecturer).
      const existing = await c.query<{ id: string }>(
        `SELECT id FROM roster_entries
          WHERE course_id = $1 AND retired_at IS NULL AND student_id_norm = $2`,
        [input.courseId, student.student_id_norm],
      );
      const entryId =
        existing.rows[0]?.id ??
        (
          await c.query<{ id: string }>(
            `INSERT INTO roster_entries (course_id, import_id, student_id_norm, full_name)
             VALUES ($1, NULL, $2, $3) RETURNING id`,
            [input.courseId, student.student_id_norm, student.full_name],
          )
        ).rows[0]!.id;

      return await decideLinkWithin(c, {
        courseId: input.courseId,
        linkId: input.linkId,
        actorId: input.actorId,
        decision: 'CONFIRM',
        basis: 'LECTURER_ENROLLMENT_CONFIRMED',
        entryId,
        explanation: 'Added to the class list by the lecturer.',
      });
    });
  } catch (err) {
    if (isUniqueViolation(err, 'roster_links_entry_holder_key')) {
      throw new ReviewError(
        409,
        'ENTRY_HELD',
        'Another student is linked to that entry. Resolve that match first.',
      );
    }
    throw err;
  }
}

/**
 * "Not part of class": removes the student from the course. The match is rejected and every PRESENT
 * record they have in this course is invalidated (identity/enrollment mismatch), so a removed person
 * stops counting. One tap; the reason is recorded automatically. Reversible via the normal restore.
 */
export async function removeFromClass(
  pool: pg.Pool,
  input: { courseId: string; linkId: string; actorId: string },
) {
  if (!UUID.test(input.linkId)) throw notFound();
  return await withTransaction(pool, async (c) => {
    const decision = await decideLinkWithin(c, {
      courseId: input.courseId,
      linkId: input.linkId,
      actorId: input.actorId,
      decision: 'REJECT',
      explanation: 'Removed: not on the class list.',
    });
    const present = await c.query<{ id: string; session_id: string }>(
      `SELECT id, session_id FROM attendance_records
        WHERE link_id = $1 AND course_id = $2 AND status = 'PRESENT'`,
      [input.linkId, input.courseId],
    );
    for (const r of present.rows) {
      await invalidateAttendanceWithin(c, {
        courseId: input.courseId,
        sessionId: r.session_id,
        attendanceId: r.id,
        actorId: input.actorId,
        explanation: 'Removed from the class list by the lecturer.',
        category: 'IDENTITY_ENROLLMENT_MISMATCH',
      });
    }
    return { ...decision, attendanceInvalidated: present.rows.length };
  });
}

export async function linkHistory(pool: pg.Pool, courseId: string, linkId: string) {
  if (!UUID.test(linkId)) throw notFound();
  const exists = await pool.query('SELECT 1 FROM roster_links WHERE id = $1 AND course_id = $2', [
    linkId,
    courseId,
  ]);
  if (exists.rowCount === 0) throw notFound();
  const { rows } = await pool.query(
    `SELECT r.review_no, r.review_kind::text AS kind, r.decision::text AS decision,
            r.from_state::text AS from_state, r.to_state::text AS to_state, r.basis::text AS basis,
            r.explanation, r.flag_id,
            fe.student_id_norm AS from_entry, te.student_id_norm AS to_entry,
            COALESCE(u.full_name, 'System') AS actor,
            to_char(r.decided_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS decided_at
       FROM identity_reviews r
       LEFT JOIN users u ON u.id = r.actor_user_id
       LEFT JOIN roster_entries fe ON fe.id = r.from_entry_id
       LEFT JOIN roster_entries te ON te.id = r.to_entry_id
      WHERE r.link_id = $1
      ORDER BY r.review_no`,
    [linkId],
  );
  return {
    reviews: rows.map((r) => ({
      reviewNo: r.review_no as number,
      kind: r.kind as string,
      decision: r.decision as string,
      fromState: r.from_state as string | null,
      toState: r.to_state as string,
      basis: r.basis as string | null,
      fromEntry: r.from_entry as string | null,
      toEntry: r.to_entry as string | null,
      explanation: r.explanation as string | null,
      flagId: r.flag_id as string | null,
      actor: r.actor as string,
      decidedAt: r.decided_at as string,
    })),
  };
}

/** Links awaiting a lecturer's attention, with their roster entry, flags and attendance count. */
export async function reviewQueue(pool: pg.Pool, courseId: string) {
  const links = await pool.query(
    `SELECT l.id, l.state::text AS state, u.student_id_display, u.full_name, u.email::text AS email,
            (u.email_verified_at IS NOT NULL) AS email_verified,
            e.student_id_norm AS entry_student_id, e.full_name AS entry_name,
            (SELECT count(*)::int FROM attendance_records a WHERE a.link_id = l.id) AS attendance_count
       FROM roster_links l
       JOIN users u ON u.id = l.student_id
       LEFT JOIN roster_entries e ON e.id = l.roster_entry_id
      WHERE l.course_id = $1 AND l.state IN ('PROVISIONAL', 'REVIEW_REQUIRED')
      ORDER BY (l.state = 'REVIEW_REQUIRED') DESC, u.student_id_norm`,
    [courseId],
  );
  const flags = await pool.query(
    `SELECT f.id, f.kind::text AS kind, f.state::text AS state, f.origin::text AS origin,
            f.roster_link_id, f.related_link_id, f.attendance_id, f.session_id,
            u.student_id_display, u.full_name
       FROM investigation_flags f
       LEFT JOIN roster_links l ON l.id = COALESCE(f.roster_link_id, (SELECT link_id FROM attendance_records WHERE id = f.attendance_id))
       LEFT JOIN users u ON u.id = l.student_id
      WHERE f.course_id = $1 AND f.state IN ('OPEN', 'UNDER_REVIEW')
      ORDER BY f.opened_at`,
    [courseId],
  );
  return {
    links: links.rows.map((r) => ({
      linkId: r.id as string,
      state: r.state as string,
      studentId: r.student_id_display as string,
      fullName: r.full_name as string,
      email: r.email as string,
      emailVerified: r.email_verified as boolean,
      rosterEntry: r.entry_student_id
        ? { studentId: r.entry_student_id as string, fullName: r.entry_name as string }
        : null,
      attendanceCount: r.attendance_count as number,
    })),
    flags: flags.rows.map((r) => ({
      flagId: r.id as string,
      kind: r.kind as string,
      state: r.state as string,
      origin: r.origin as string,
      linkId: (r.roster_link_id as string | null) ?? null,
      relatedLinkId: (r.related_link_id as string | null) ?? null,
      attendanceId: (r.attendance_id as string | null) ?? null,
      sessionId: (r.session_id as string | null) ?? null,
      studentId: (r.student_id_display as string | null) ?? null,
      fullName: (r.full_name as string | null) ?? null,
    })),
  };
}

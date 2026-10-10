import type pg from 'pg';
import { courseRetainUntil, writeAudit } from '../audit.js';

/**
 * Course-student association (roster link) rules. A link records how a student account relates to
 * a course roster. It is NOT identity verification: IDs and names are self-reported.
 *
 *  - no roster for the course                    -> PROVISIONAL (not enrollment)
 *  - exact student-ID match, entry unheld         -> CONFIRMED / ROSTER_ID_MATCH
 *  - else verified e-mail equals roster e-mail    -> CONFIRMED / ROSTER_EMAIL_MATCH
 *  - entry already held by another account        -> REVIEW_REQUIRED + CONFLICTING_STUDENT_ID flag
 *  - roster exists but no safe match              -> REVIEW_REQUIRED (+ AMBIGUOUS_ROSTER_MATCH flag
 *                                                    when similar names exist)
 * Similar names are only ever suggested to a lecturer; they never link or merge anything.
 */
type Client = pg.PoolClient;

export type LinkState = 'PROVISIONAL' | 'REVIEW_REQUIRED' | 'CONFIRMED' | 'REJECTED';
export type Basis =
  | 'ROSTER_ID_MATCH'
  | 'ROSTER_EMAIL_MATCH'
  | 'LECTURER_IDENTITY_CONFIRMED'
  | 'LECTURER_ENROLLMENT_CONFIRMED';

export interface LinkRow {
  id: string;
  course_id: string;
  student_id: string;
  roster_entry_id: string | null;
  state: LinkState;
  confirmed_basis: Basis | null;
  current_review_no: number;
}

interface Student {
  id: string;
  student_id_norm: string;
  email: string;
  email_verified: boolean;
  full_name: string;
}

interface EntryRow {
  id: string;
  student_id_norm: string;
  full_name: string;
}

/** Candidates below this trigram similarity are not suggested. */
export const SUGGESTION_MIN_SIMILARITY = 0.4;
const SUGGESTION_LIMIT = 5;

const LINK_COLUMNS = `id, course_id, student_id, roster_entry_id, state, confirmed_basis, current_review_no`;

export async function hasActiveRoster(c: Client, courseId: string): Promise<boolean> {
  const { rowCount } = await c.query(
    'SELECT 1 FROM roster_entries WHERE course_id = $1 AND retired_at IS NULL LIMIT 1',
    [courseId],
  );
  return (rowCount ?? 0) > 0;
}

async function holderOf(c: Client, entryId: string): Promise<LinkRow | null> {
  const { rows } = await c.query<LinkRow>(
    `SELECT ${LINK_COLUMNS} FROM roster_links WHERE roster_entry_id = $1 AND state <> 'REJECTED'`,
    [entryId],
  );
  return rows[0] ?? null;
}

export async function getLink(
  c: Client,
  courseId: string,
  studentId: string,
): Promise<LinkRow | null> {
  const { rows } = await c.query<LinkRow>(
    `SELECT ${LINK_COLUMNS} FROM roster_links WHERE course_id = $1 AND student_id = $2`,
    [courseId, studentId],
  );
  return rows[0] ?? null;
}

/**
 * Appends a system review and moves the link to its new state, atomically. The update is a
 * compare-and-swap on current_review_no, so a concurrent change makes this fail instead of
 * overwriting.
 */
export async function transitionLink(
  c: Client,
  link: LinkRow,
  next: {
    state: LinkState;
    decision: 'SYSTEM_MATCH' | 'SYSTEM_DOWNGRADE' | 'SYSTEM_REPOINT';
    basis?: Basis | null;
    entryId?: string | null;
    flagId?: string | null;
  },
): Promise<LinkRow> {
  const reviewNo = link.current_review_no + 1;
  const basis = next.state === 'CONFIRMED' ? (next.basis ?? null) : null;
  const entryId = next.entryId === undefined ? link.roster_entry_id : next.entryId;

  await c.query(
    `INSERT INTO identity_reviews
       (link_id, review_no, review_kind, decision, from_state, to_state,
        from_entry_id, to_entry_id, basis, flag_id)
     VALUES ($1, $2, 'SYSTEM_MATCH', $3, $4, $5, $6, $7, $8, $9)`,
    [
      link.id,
      reviewNo,
      next.decision,
      link.state,
      next.state,
      link.roster_entry_id,
      entryId,
      basis,
      next.flagId ?? null,
    ],
  );
  const updated = await c.query<LinkRow>(
    `UPDATE roster_links
        SET state = $3, confirmed_basis = $4, roster_entry_id = $5, current_review_no = $6
      WHERE id = $1 AND current_review_no = $2
      RETURNING ${LINK_COLUMNS}`,
    [link.id, link.current_review_no, next.state, basis, entryId, reviewNo],
  );
  const row = updated.rows[0];
  if (!row) throw new Error('roster link changed concurrently');
  return row;
}

async function raiseFlag(
  c: Client,
  input: {
    courseId: string;
    kind: 'CONFLICTING_STUDENT_ID' | 'AMBIGUOUS_ROSTER_MATCH';
    linkId: string;
    relatedLinkId?: string;
    detail: Record<string, unknown>;
  },
): Promise<string | null> {
  const { rows } = await c.query<{ id: string }>(
    `INSERT INTO investigation_flags (course_id, roster_link_id, related_link_id, kind, origin, detail)
     VALUES ($1, $2, $3, $4, 'SYSTEM', $5)
     ON CONFLICT DO NOTHING
     RETURNING id`,
    [
      input.courseId,
      input.linkId,
      input.relatedLinkId ?? null,
      input.kind,
      JSON.stringify(input.detail),
    ],
  );
  const id = rows[0]?.id;
  if (!id) return null; // an identical flag is already active
  await c.query(
    `INSERT INTO investigation_flag_events (flag_id, event_no, from_state, to_state)
     VALUES ($1, 1, NULL, 'OPEN')`,
    [id],
  );
  return id;
}

export async function suggestCandidates(
  c: Pick<Client, 'query'>,
  courseId: string,
  fullName: string,
): Promise<Array<EntryRow & { score: number }>> {
  const { rows } = await c.query<EntryRow & { score: number }>(
    `SELECT e.id, e.student_id_norm, e.full_name,
            similarity(lower(e.full_name), lower($2))::float AS score
       FROM roster_entries e
      WHERE e.course_id = $1 AND e.retired_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM roster_links l
                         WHERE l.roster_entry_id = e.id AND l.state <> 'REJECTED')
        AND similarity(lower(e.full_name), lower($2)) >= $3
      ORDER BY score DESC, e.student_id_norm
      LIMIT $4`,
    [courseId, fullName, SUGGESTION_MIN_SIMILARITY, SUGGESTION_LIMIT],
  );
  return rows;
}

async function findEntry(
  c: Client,
  courseId: string,
  student: Student,
): Promise<{ entry: EntryRow; basis: 'ROSTER_ID_MATCH' | 'ROSTER_EMAIL_MATCH' } | null> {
  const byId = await c.query<EntryRow>(
    `SELECT id, student_id_norm, full_name FROM roster_entries
      WHERE course_id = $1 AND retired_at IS NULL AND student_id_norm = $2`,
    [courseId, student.student_id_norm],
  );
  if (byId.rows[0]) return { entry: byId.rows[0], basis: 'ROSTER_ID_MATCH' };

  // E-mail is only a fallback, and only when the address is genuinely verified.
  if (student.email_verified) {
    const byEmail = await c.query<EntryRow>(
      `SELECT id, student_id_norm, full_name FROM roster_entries
        WHERE course_id = $1 AND retired_at IS NULL AND school_email = $2`,
      [courseId, student.email],
    );
    if (byEmail.rows[0]) return { entry: byEmail.rows[0], basis: 'ROSTER_EMAIL_MATCH' };
  }
  return null;
}

type Outcome =
  | { kind: 'MATCH'; entry: EntryRow; basis: 'ROSTER_ID_MATCH' | 'ROSTER_EMAIL_MATCH' }
  | { kind: 'CONTESTED'; entry: EntryRow; holder: LinkRow }
  | { kind: 'NO_MATCH' }
  | { kind: 'NO_ROSTER' };

async function evaluate(c: Client, courseId: string, student: Student): Promise<Outcome> {
  if (!(await hasActiveRoster(c, courseId))) return { kind: 'NO_ROSTER' };
  const found = await findEntry(c, courseId, student);
  if (!found) return { kind: 'NO_MATCH' };
  const holder = await holderOf(c, found.entry.id);
  if (holder && holder.student_id !== student.id)
    return { kind: 'CONTESTED', entry: found.entry, holder };
  return { kind: 'MATCH', ...found };
}

async function loadStudent(c: Client, studentId: string): Promise<Student> {
  const { rows } = await c.query<Student>(
    `SELECT id, student_id_norm, email::text AS email, (email_verified_at IS NOT NULL) AS email_verified, full_name
       FROM users WHERE id = $1 AND role = 'STUDENT'`,
    [studentId],
  );
  const s = rows[0];
  if (!s) throw new Error('student account not found');
  return s;
}

/** After a contest: the system-confirmed holder is sent back for review; lecturer decisions stand. */
async function downgradeSystemHolder(
  c: Client,
  holder: LinkRow,
  flagId: string | null,
): Promise<void> {
  const systemBasis =
    holder.confirmed_basis === 'ROSTER_ID_MATCH' || holder.confirmed_basis === 'ROSTER_EMAIL_MATCH';
  if (holder.state === 'CONFIRMED' && systemBasis) {
    await transitionLink(c, holder, {
      state: 'REVIEW_REQUIRED',
      decision: 'SYSTEM_DOWNGRADE',
      flagId,
    });
  }
}

interface NewLinkPlan {
  state: LinkState;
  basis?: Basis | null;
  entryId?: string | null;
}

/** Inserts a link and its first review. Returns null if the (course, student) link already exists. */
async function insertLink(
  c: Client,
  courseId: string,
  studentId: string,
  plan: NewLinkPlan,
): Promise<LinkRow | null> {
  const { rows } = await c.query<LinkRow>(
    `INSERT INTO roster_links (course_id, student_id, roster_entry_id, state, confirmed_basis)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (course_id, student_id) DO NOTHING
     RETURNING ${LINK_COLUMNS}`,
    [courseId, studentId, plan.entryId ?? null, plan.state, plan.basis ?? null],
  );
  const link = rows[0];
  if (!link) return null;
  await c.query(
    `INSERT INTO identity_reviews (link_id, review_no, review_kind, decision, from_state, to_state, to_entry_id, basis)
     VALUES ($1, 1, 'SYSTEM_MATCH', 'SYSTEM_MATCH', NULL, $2, $3, $4)`,
    [link.id, plan.state, plan.entryId ?? null, plan.basis ?? null],
  );
  return link;
}

/**
 * Returns the student's link for the course, creating it by the rules above if needed. Must run
 * inside a transaction (the link and its first review are tied together by a deferred constraint).
 * Safe to call concurrently for the same student: exactly one link results.
 */
export async function ensureLink(
  c: Client,
  courseId: string,
  studentId: string,
): Promise<{ link: LinkRow; created: boolean }> {
  const existing = await getLink(c, courseId, studentId);
  if (existing) return { link: existing, created: false };

  const student = await loadStudent(c, studentId);
  const outcome = await evaluate(c, courseId, student);

  let link: LinkRow | null = null;
  let contest: { entry: EntryRow; holder: LinkRow } | null = null;

  if (outcome.kind === 'NO_ROSTER') {
    link = await insertLink(c, courseId, studentId, { state: 'PROVISIONAL' });
  } else if (outcome.kind === 'MATCH') {
    // The claim runs in a savepoint: if another account claims the entry at the same moment, the
    // unique index rejects one of us and that account falls back to review instead of failing.
    await c.query('SAVEPOINT claim_entry');
    try {
      link = await insertLink(c, courseId, studentId, {
        state: 'CONFIRMED',
        basis: outcome.basis,
        entryId: outcome.entry.id,
      });
      await c.query('RELEASE SAVEPOINT claim_entry');
    } catch (err) {
      await c.query('ROLLBACK TO SAVEPOINT claim_entry');
      if ((err as { code?: string }).code !== '23505') throw err;
      const holder = await holderOf(c, outcome.entry.id);
      if (!holder) throw err;
      contest = { entry: outcome.entry, holder };
    }
  } else if (outcome.kind === 'CONTESTED') {
    contest = { entry: outcome.entry, holder: outcome.holder };
  }

  if (contest) {
    link = await insertLink(c, courseId, studentId, { state: 'REVIEW_REQUIRED' });
    if (link) {
      const flagId = await raiseFlag(c, {
        courseId,
        kind: 'CONFLICTING_STUDENT_ID',
        linkId: link.id,
        relatedLinkId: contest.holder.id,
        detail: { rosterEntryId: contest.entry.id },
      });
      await downgradeSystemHolder(c, contest.holder, flagId);
    }
  } else if (outcome.kind === 'NO_MATCH') {
    link = await insertLink(c, courseId, studentId, { state: 'REVIEW_REQUIRED' });
    if (link) await flagIfAmbiguous(c, courseId, link, student.full_name);
  }

  if (!link) {
    // Lost a race with a concurrent creation of the same link; theirs is the one that exists.
    const winner = await getLink(c, courseId, studentId);
    if (!winner) throw new Error('roster link vanished');
    return { link: winner, created: false };
  }

  await writeAudit(c, {
    class: 'DOMAIN',
    actorType: 'SYSTEM',
    action: 'ROSTER_LINK_CREATED',
    courseId,
    entityType: 'roster_link',
    entityId: link.id,
    retainUntil: await courseRetainUntil(c, courseId),
    summary: { state: link.state, basis: link.confirmed_basis },
  });
  return { link, created: true };
}

async function flagIfAmbiguous(
  c: Client,
  courseId: string,
  link: LinkRow,
  fullName: string,
): Promise<void> {
  const candidates = await suggestCandidates(c, courseId, fullName);
  if (candidates.length > 0) {
    await raiseFlag(c, {
      courseId,
      kind: 'AMBIGUOUS_ROSTER_MATCH',
      linkId: link.id,
      detail: { candidateEntryIds: candidates.map((x) => x.id) },
    });
  }
}

/**
 * After a roster import, re-evaluates links that were created while the course had no roster
 * (PROVISIONAL, no entry). Safe matches are confirmed by the same rules as at check-in; the rest go
 * to review. Links already in review or decided by a lecturer are never touched.
 */
export async function rematchProvisionalLinks(
  c: Client,
  courseId: string,
): Promise<{ confirmed: number; reviewRequired: number }> {
  const { rows } = await c.query<LinkRow>(
    `SELECT ${LINK_COLUMNS} FROM roster_links
      WHERE course_id = $1 AND state = 'PROVISIONAL' AND roster_entry_id IS NULL
      ORDER BY created_at, id`,
    [courseId],
  );
  let confirmed = 0;
  let reviewRequired = 0;
  for (const link of rows) {
    const student = await loadStudent(c, link.student_id);
    const outcome = await evaluate(c, courseId, student);
    if (outcome.kind === 'MATCH') {
      await transitionLink(c, link, {
        state: 'CONFIRMED',
        decision: 'SYSTEM_MATCH',
        basis: outcome.basis,
        entryId: outcome.entry.id,
      });
      confirmed += 1;
    } else if (outcome.kind === 'CONTESTED') {
      const flagId = await raiseFlag(c, {
        courseId,
        kind: 'CONFLICTING_STUDENT_ID',
        linkId: link.id,
        relatedLinkId: outcome.holder.id,
        detail: { rosterEntryId: outcome.entry.id },
      });
      await transitionLink(c, link, {
        state: 'REVIEW_REQUIRED',
        decision: 'SYSTEM_DOWNGRADE',
        flagId,
      });
      await downgradeSystemHolder(c, outcome.holder, flagId);
      reviewRequired += 1;
    } else if (outcome.kind === 'NO_MATCH') {
      await transitionLink(c, link, { state: 'REVIEW_REQUIRED', decision: 'SYSTEM_DOWNGRADE' });
      await flagIfAmbiguous(c, courseId, link, student.full_name);
      reviewRequired += 1;
    }
  }
  return { confirmed, reviewRequired };
}

export { holderOf };

import type pg from 'pg';
import { courseRetainUntil, writeAudit } from '../audit.js';
import { sha256 } from '../auth/crypto.js';
import { withTransaction } from '../db/pool.js';
import { parseRosterCsv, type RosterRow } from './csv.js';
import { holderOf, rematchProvisionalLinks, transitionLink, type LinkRow } from './matching.js';

type Client = pg.PoolClient;

export class RosterError extends Error {
  constructor(
    readonly status: 400 | 409,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

interface ActiveEntry {
  id: string;
  student_id_norm: string;
  full_name: string;
  school_email: string | null;
}

export interface Diff {
  added: RosterRow[];
  changed: Array<{ entryId: string; row: RosterRow; before: ActiveEntry }>;
  unchanged: number;
  missing: ActiveEntry[];
}

const ACTIVE_ENTRIES = `
  SELECT id, student_id_norm, full_name, school_email::text AS school_email
    FROM roster_entries WHERE course_id = $1 AND retired_at IS NULL
   ORDER BY student_id_norm`;

/**
 * Compares a parsed file with the course's ACTIVE entries. Existing entries are never edited:
 * a changed row becomes a new entry that supersedes the old one. When the file has no e-mail
 * column, e-mail is left out of the comparison (it is not treated as "removed").
 */
export async function computeDiff(
  c: Pick<Client, 'query'>,
  courseId: string,
  rows: RosterRow[],
  hasEmailColumn: boolean,
): Promise<{ diff: Diff; activeIds: string[] }> {
  const { rows: active } = await c.query<ActiveEntry>(ACTIVE_ENTRIES, [courseId]);
  const byId = new Map(active.map((e) => [e.student_id_norm, e]));
  const seen = new Set<string>();
  const diff: Diff = { added: [], changed: [], unchanged: 0, missing: [] };

  for (const row of rows) {
    seen.add(row.studentId);
    const existing = byId.get(row.studentId);
    if (!existing) {
      diff.added.push(row);
    } else {
      const nameChanged = existing.full_name.toLowerCase() !== row.fullName.toLowerCase();
      const emailChanged = hasEmailColumn && (existing.school_email ?? null) !== row.email;
      if (nameChanged || emailChanged)
        diff.changed.push({ entryId: existing.id, row, before: existing });
      else diff.unchanged += 1;
    }
  }
  diff.missing = active.filter((e) => !seen.has(e.student_id_norm));
  return { diff, activeIds: active.map((e) => e.id) };
}

/**
 * Ties an approval to both the exact file and the roster it was previewed against, so applying
 * a stale preview (someone else imported in between) is refused rather than guessed at.
 */
function previewToken(csv: string, activeIds: string[]): string {
  return sha256(`${sha256(csv).toString('hex')}\n${activeIds.join(',')}`).toString('hex');
}

function parseOrThrow(csv: string) {
  const parsed = parseRosterCsv(csv);
  if (!parsed.ok) {
    throw new RosterError(400, 'INVALID_ROSTER', 'The roster file could not be used.', {
      reason: parsed.code,
      rowErrors: parsed.errors,
    });
  }
  return parsed;
}

export interface Preview {
  fileSha256: string;
  previewToken: string;
  hasEmailColumn: boolean;
  counts: { added: number; changed: number; unchanged: number; missing: number };
  added: Array<{ line: number; studentId: string; fullName: string; email: string | null }>;
  changed: Array<{
    entryId: string;
    studentId: string;
    before: { fullName: string; email: string | null };
    after: { fullName: string; email: string | null };
  }>;
  missing: Array<{ entryId: string; studentId: string; fullName: string; heldBy: string | null }>;
}

/** Read-only: shows what an import would do. Nothing is written. */
export async function previewImport(
  pool: pg.Pool,
  courseId: string,
  csv: string,
): Promise<Preview> {
  const parsed = parseOrThrow(csv);
  const client = await pool.connect();
  try {
    const { diff, activeIds } = await computeDiff(
      client,
      courseId,
      parsed.rows,
      parsed.hasEmailColumn,
    );
    const missing = [];
    for (const e of diff.missing) {
      const holder = await holderOf(client, e.id);
      missing.push({
        entryId: e.id,
        studentId: e.student_id_norm,
        fullName: e.full_name,
        heldBy: holder?.id ?? null,
      });
    }
    return {
      fileSha256: sha256(csv).toString('hex'),
      previewToken: previewToken(csv, activeIds),
      hasEmailColumn: parsed.hasEmailColumn,
      counts: {
        added: diff.added.length,
        changed: diff.changed.length,
        unchanged: diff.unchanged,
        missing: diff.missing.length,
      },
      added: diff.added.map((r) => ({
        line: r.line,
        studentId: r.studentId,
        fullName: r.fullName,
        email: r.email,
      })),
      changed: diff.changed.map((x) => ({
        entryId: x.entryId,
        studentId: x.row.studentId,
        before: { fullName: x.before.full_name, email: x.before.school_email },
        after: {
          fullName: x.row.fullName,
          email: parsed.hasEmailColumn ? x.row.email : x.before.school_email,
        },
      })),
      missing,
    };
  } finally {
    client.release();
  }
}

export interface ApplyResult {
  noChanges: boolean;
  importId: string | null;
  added: number;
  changed: number;
  retired: number;
  rematched: { confirmed: number; reviewRequired: number };
}

async function retireEntry(c: Client, entryId: string): Promise<void> {
  await c.query(
    'UPDATE roster_entries SET retired_at = clock_timestamp() WHERE id = $1 AND retired_at IS NULL',
    [entryId],
  );
}

/**
 * Applies a previously previewed import in one transaction. The course row is locked first, so
 * concurrent imports are serialised and the diff is recomputed against the roster as it is now.
 * MISSING entries are retired only if the lecturer lists them in `retireEntryIds`.
 */
export async function applyImport(
  pool: pg.Pool,
  input: {
    courseId: string;
    actorId: string;
    csv: string;
    previewToken: string;
    retireEntryIds: string[];
  },
): Promise<ApplyResult> {
  const parsed = parseOrThrow(input.csv);
  const fileHash = sha256(input.csv);

  try {
    return await withTransaction(pool, async (c) => {
      // Serialise imports per course; held until commit. An advisory lock is used because a row
      // lock (FOR UPDATE) would need UPDATE privilege on courses, which the app role lacks.
      await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
        `roster-import:${input.courseId}`,
      ]);

      const { diff, activeIds } = await computeDiff(
        c,
        input.courseId,
        parsed.rows,
        parsed.hasEmailColumn,
      );
      if (previewToken(input.csv, activeIds) !== input.previewToken) {
        throw new RosterError(
          409,
          'STALE_PREVIEW',
          'The roster changed since this preview. Preview again.',
        );
      }

      const missingIds = new Set(diff.missing.map((e) => e.id));
      const retire = [...new Set(input.retireEntryIds)];
      if (retire.some((id) => !missingIds.has(id))) {
        throw new RosterError(
          400,
          'INVALID_RETIREMENT',
          'Only entries missing from the file can be retired.',
        );
      }

      const nothingToDo =
        diff.added.length === 0 && diff.changed.length === 0 && retire.length === 0;
      if (nothingToDo) {
        return {
          noChanges: true,
          importId: null,
          added: 0,
          changed: 0,
          retired: 0,
          rematched: { confirmed: 0, reviewRequired: 0 },
        };
      }

      const { rows: importRows } = await c.query<{ id: string }>(
        `INSERT INTO roster_imports (course_id, uploaded_by, file_sha256, row_count, status)
         VALUES ($1, $2, $3, $4, 'APPLIED') RETURNING id`,
        [input.courseId, input.actorId, fileHash, parsed.rows.length],
      );
      const importId = importRows[0]?.id as string;

      // Free the unique "active" slots first: retire everything being replaced or removed.
      for (const x of diff.changed) await retireEntry(c, x.entryId);
      for (const id of retire) await retireEntry(c, id);

      const insertEntry = async (r: RosterRow, fallbackEmail: string | null): Promise<string> => {
        const { rows } = await c.query<{ id: string }>(
          `INSERT INTO roster_entries (course_id, import_id, student_id_norm, full_name, school_email)
           VALUES ($1, $2, $3, $4, $5) RETURNING id`,
          [
            input.courseId,
            importId,
            r.studentId,
            r.fullName,
            parsed.hasEmailColumn ? r.email : fallbackEmail,
          ],
        );
        return rows[0]?.id as string;
      };

      for (const r of diff.added) await insertEntry(r, null);

      for (const x of diff.changed) {
        const newId = await insertEntry(x.row, x.before.school_email);
        await c.query('UPDATE roster_entries SET superseded_by = $2 WHERE id = $1', [
          x.entryId,
          newId,
        ]);
        // A link pointing at the old entry follows it to the new one, with a recorded review.
        const holder = await holderOf(c, x.entryId);
        if (holder) {
          await transitionLink(c, holder, {
            state: holder.state,
            decision: 'SYSTEM_REPOINT',
            basis: holder.confirmed_basis,
            entryId: newId,
          });
        }
      }

      // A retired entry that someone held is no longer on the roster: send that link to review.
      for (const id of retire) {
        const holder: LinkRow | null = await holderOf(c, id);
        if (holder && holder.state !== 'REVIEW_REQUIRED') {
          await transitionLink(c, holder, {
            state: 'REVIEW_REQUIRED',
            decision: 'SYSTEM_DOWNGRADE',
          });
        }
      }

      const rematched = await rematchProvisionalLinks(c, input.courseId);

      await writeAudit(c, {
        class: 'DOMAIN',
        actorType: 'LECTURER',
        actorUserId: input.actorId,
        action: 'ROSTER_IMPORTED',
        courseId: input.courseId,
        entityType: 'roster_import',
        entityId: importId,
        retainUntil: await courseRetainUntil(c, input.courseId),
        summary: {
          added: diff.added.length,
          changed: diff.changed.length,
          retired: retire.length,
          rematchedConfirmed: rematched.confirmed,
          rematchedForReview: rematched.reviewRequired,
        },
      });

      return {
        noChanges: false,
        importId,
        added: diff.added.length,
        changed: diff.changed.length,
        retired: retire.length,
        rematched,
      };
    });
  } catch (err) {
    if ((err as { code?: string }).code === '23505') {
      throw new RosterError(
        409,
        'ROSTER_CONFLICT',
        'An entry in the file clashes with an existing roster entry (same e-mail or student ID).',
      );
    }
    throw err;
  }
}

export interface RosterView {
  hasRoster: boolean;
  entries: Array<{
    id: string;
    studentId: string;
    fullName: string;
    schoolEmail: string | null;
    registered: boolean;
    link: { id: string; state: string; basis: string | null } | null;
  }>;
  /** Accounts linked to the course without a roster entry: self-reported, not confirmed enrollment. */
  unmatchedLinks: Array<{
    linkId: string;
    studentId: string;
    fullName: string;
    state: string;
    selfReported: true;
  }>;
}

export async function listRoster(pool: pg.Pool, courseId: string): Promise<RosterView> {
  const entries = await pool.query(
    `SELECT e.id, e.student_id_norm, e.full_name, e.school_email::text AS school_email,
            l.id AS link_id, l.state, l.confirmed_basis,
            EXISTS (SELECT 1 FROM users u WHERE u.student_id_norm = e.student_id_norm) AS registered
       FROM roster_entries e
       LEFT JOIN roster_links l ON l.roster_entry_id = e.id AND l.state <> 'REJECTED'
      WHERE e.course_id = $1 AND e.retired_at IS NULL
      ORDER BY e.student_id_norm`,
    [courseId],
  );
  const unmatched = await pool.query(
    `SELECT l.id AS link_id, u.student_id_display, u.full_name, l.state
       FROM roster_links l JOIN users u ON u.id = l.student_id
      WHERE l.course_id = $1 AND l.roster_entry_id IS NULL
      ORDER BY u.student_id_norm`,
    [courseId],
  );
  return {
    hasRoster: entries.rows.length > 0,
    entries: entries.rows.map((r) => ({
      id: r.id,
      studentId: r.student_id_norm,
      fullName: r.full_name,
      schoolEmail: r.school_email,
      registered: r.registered,
      link: r.link_id ? { id: r.link_id, state: r.state, basis: r.confirmed_basis } : null,
    })),
    unmatchedLinks: unmatched.rows.map((r) => ({
      linkId: r.link_id,
      studentId: r.student_id_display,
      fullName: r.full_name,
      state: r.state,
      selfReported: true as const,
    })),
  };
}

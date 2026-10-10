import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type pg from 'pg';

/**
 * Audit checkpoints: tamper EVIDENCE, not tamper-proofing.
 *
 * The audit table is append-only for the application, but anyone with database-owner access could
 * still rewrite it. A checkpoint copies a fingerprint (id, hash, retain-until) of each audit row to
 * a location the database owner does NOT control. Later, verification compares the database to
 * those fingerprints and reports modified, missing (while still within retention), or extra rows,
 * and gaps in the sequence of checkpoints.
 *
 * What this does not do: stop a person who controls BOTH the database and the checkpoint location.
 * It is only meaningful if the sink is owned by someone independent (e.g. university IT, in a
 * separate cloud account with write-once storage). Whether to enable it is an open decision; it is
 * off unless a sink is configured. Fingerprints contain no names or other personal data.
 */
export interface CheckpointSink {
  /** Must refuse to overwrite an existing segment. */
  write(name: string, content: string): Promise<void>;
  read(name: string): Promise<string>;
  list(): Promise<string[]>;
}

export class FileCheckpointSink implements CheckpointSink {
  constructor(private readonly dir: string) {}

  async write(name: string, content: string): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    await writeFile(join(this.dir, name), content, { flag: 'wx' }); // never overwrite
  }
  read(name: string): Promise<string> {
    return readFile(join(this.dir, name), 'utf8');
  }
  async list(): Promise<string[]> {
    return (await readdir(this.dir).catch(() => []))
      .filter((n) => /^audit-\d{12}\.json$/.test(n))
      .sort();
  }
}

export class MemoryCheckpointSink implements CheckpointSink {
  readonly files = new Map<string, string>();
  async write(name: string, content: string): Promise<void> {
    if (this.files.has(name)) throw new Error('exists');
    this.files.set(name, content);
  }
  async read(name: string): Promise<string> {
    const v = this.files.get(name);
    if (v === undefined) throw new Error('missing');
    return v;
  }
  async list(): Promise<string[]> {
    return [...this.files.keys()].sort();
  }
}

interface Entry {
  id: number;
  /** SHA-256 over the row's canonical text. */
  h: string;
  /** Date after which the row may legitimately be purged. */
  ru: string;
}

interface Segment {
  version: 1;
  /** Rows with id in (after, upTo]. Segments must chain: each `after` equals the previous `upTo`. */
  after: number;
  upTo: number;
  createdAt: string;
  entries: Entry[];
}

/** The row fingerprint is computed by the database so the checkpointer and verifier agree exactly. */
const HASH_SQL = `
  encode(sha256(convert_to(concat_ws('|',
    id,
    to_char(occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US'),
    class, actor_type, COALESCE(actor_user_id::text, '~'), action, outcome,
    COALESCE(course_id::text, '~'), COALESCE(session_id::text, '~'),
    COALESCE(entity_type, '~'), COALESCE(entity_id, '~'), COALESCE(request_id, '~'),
    summary::text, COALESCE(encode(ip_hash, 'hex'), '~'), retain_until::text
  ), 'UTF8')), 'hex')`;

const name = (upTo: number) => `audit-${String(upTo).padStart(12, '0')}.json`;

async function lastSegment(sink: CheckpointSink): Promise<Segment | null> {
  const names = await sink.list();
  const last = names.at(-1);
  return last ? (JSON.parse(await sink.read(last)) as Segment) : null;
}

/**
 * Fingerprints all audit rows added since the previous checkpoint and writes them as one segment.
 * Rows younger than `safetyMinutes` are left for the next run: ids are handed out when a row is
 * inserted but become visible at commit, so a very recent id could still be about to appear below
 * the newest visible one, and including a half-settled range would cause false alarms.
 */
export async function writeCheckpoint(
  pool: Pick<pg.Pool, 'query'>,
  sink: CheckpointSink,
  safetyMinutes = 2,
): Promise<{ written: boolean; entries: number }> {
  const prev = await lastSegment(sink);
  const after = prev?.upTo ?? 0;
  const { rows } = await pool.query<{ id: string; h: string; ru: string }>(
    `WITH bound AS (
       SELECT COALESCE(
         (SELECT min(id) - 1 FROM audit_events WHERE occurred_at >= clock_timestamp() - make_interval(mins => $2)),
         (SELECT max(id) FROM audit_events), 0) AS up_to)
     SELECT id, ${HASH_SQL} AS h, to_char(retain_until, 'YYYY-MM-DD') AS ru
       FROM audit_events, bound WHERE id > $1 AND id <= bound.up_to ORDER BY id`,
    [after, safetyMinutes],
  );
  if (rows.length === 0) return { written: false, entries: 0 };
  const upTo = Number(rows.at(-1)!.id);
  const segment: Segment = {
    version: 1,
    after,
    upTo,
    createdAt: new Date().toISOString(),
    entries: rows.map((r) => ({ id: Number(r.id), h: r.h, ru: r.ru })),
  };
  await sink.write(name(upTo), JSON.stringify(segment));
  return { written: true, entries: rows.length };
}

export type Problem =
  | { kind: 'MODIFIED'; id: number }
  | { kind: 'MISSING'; id: number }
  | { kind: 'EXTRA'; id: number }
  | { kind: 'GAP'; between: [number, number] }
  | { kind: 'BAD_SEGMENT'; name: string };

/**
 * Compares the database with every checkpoint. A row that is gone is only acceptable if its
 * retain-until date has passed (a legitimate purge); anything else is reported.
 */
export async function verifyCheckpoints(
  pool: Pick<pg.Pool, 'query'>,
  sink: CheckpointSink,
): Promise<{ ok: boolean; problems: Problem[]; checkedRows: number }> {
  const problems: Problem[] = [];
  let expectedAfter = 0;
  let checked = 0;
  const today = (await pool.query<{ d: string }>(`SELECT to_char(current_date, 'YYYY-MM-DD') AS d`))
    .rows[0]!.d;

  for (const file of await sink.list()) {
    let segment: Segment;
    try {
      segment = JSON.parse(await sink.read(file)) as Segment;
      if (segment.version !== 1 || !Array.isArray(segment.entries)) throw new Error('shape');
    } catch {
      problems.push({ kind: 'BAD_SEGMENT', name: file });
      continue;
    }
    if (segment.after !== expectedAfter)
      problems.push({ kind: 'GAP', between: [expectedAfter, segment.after] });
    expectedAfter = segment.upTo;

    const { rows } = await pool.query<{ id: string; h: string }>(
      `SELECT id, ${HASH_SQL} AS h FROM audit_events WHERE id > $1 AND id <= $2 ORDER BY id`,
      [segment.after, segment.upTo],
    );
    const now = new Map(rows.map((r) => [Number(r.id), r.h]));
    const was = new Set<number>();
    for (const e of segment.entries) {
      was.add(e.id);
      checked += 1;
      const current = now.get(e.id);
      if (current === undefined) {
        if (e.ru >= today) problems.push({ kind: 'MISSING', id: e.id });
      } else if (current !== e.h) {
        problems.push({ kind: 'MODIFIED', id: e.id });
      }
    }
    for (const id of now.keys()) if (!was.has(id)) problems.push({ kind: 'EXTRA', id });
  }
  return { ok: problems.length === 0, problems, checkedRows: checked };
}

export function startCheckpointJob(
  pool: pg.Pool,
  sink: CheckpointSink,
  onError: (e: unknown) => void,
  everyMs = 3600_000,
): () => void {
  let running = false;
  const timer = setInterval(() => {
    if (running) return;
    running = true;
    writeCheckpoint(pool, sink)
      .catch(onError)
      .finally(() => {
        running = false;
      });
  }, everyMs);
  timer.unref();
  return () => clearInterval(timer);
}

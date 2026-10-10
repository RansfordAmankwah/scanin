import { createHash, randomUUID } from 'node:crypto';
import type pg from 'pg';
import { courseRetainUntil, writeAudit } from '../audit.js';
import { withTransaction } from '../db/pool.js';
import { buildReport, ReportNotFound, SAFE_FILENAME, type ReportKind } from './model.js';
import { FORMATS, render, type ExportFormat } from './render/index.js';
import type { ExportStorage } from './storage.js';

export class ExportError extends Error {
  constructor(
    readonly status: 404 | 410,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export interface ExportSummary {
  id: string;
  filename: string;
  format: ExportFormat;
  kind: ReportKind;
  rowCount: number;
  expiresAt: string;
  downloadPath: string;
}

const iso = (d: Date) => d.toISOString();

/**
 * Builds the report from one snapshot, renders the requested format, stores the file privately,
 * and records the export with its audit event. Exporting only reads attendance data: it changes no
 * attendance, association or flag.
 */
export async function createExport(
  pool: pg.Pool,
  storage: ExportStorage,
  input: {
    courseId: string;
    sessionId: string;
    kind: ReportKind;
    format: ExportFormat;
    actorId: string;
    ttlMinutes: number;
  },
): Promise<ExportSummary> {
  let model;
  try {
    model = await buildReport(pool, input);
  } catch (err) {
    if (err instanceof ReportNotFound) throw new ExportError(404, 'NOT_FOUND', 'Not found.');
    throw err;
  }

  const id = randomUUID();
  const { ext } = FORMATS[input.format];
  const filename = SAFE_FILENAME(model.meta, ext, id.slice(0, 8));
  const data = await render(input.format, model);
  const storageKey = `${id}.${ext}`;
  await storage.put(storageKey, data);

  try {
    const expiresAt = await withTransaction(pool, async (c) => {
      const { rows } = await c.query<{ expires_at: Date }>(
        `INSERT INTO export_records
           (id, course_id, session_id, requested_by, report_kind, format, params, status, row_count,
            file_sha256, storage_key, ready_at, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'READY', $8, $9, $10, clock_timestamp(),
                 clock_timestamp() + make_interval(mins => $11))
         RETURNING expires_at`,
        [
          id,
          input.courseId,
          input.sessionId,
          input.actorId,
          input.kind,
          input.format,
          JSON.stringify({ filename }),
          model.table.rows.length,
          createHash('sha256').update(data).digest(),
          storageKey,
          input.ttlMinutes,
        ],
      );
      await writeAudit(c, {
        class: 'DOMAIN',
        actorType: 'LECTURER',
        actorUserId: input.actorId,
        action: 'EXPORT_REQUESTED',
        courseId: input.courseId,
        sessionId: input.sessionId,
        entityType: 'export',
        entityId: id,
        retainUntil: await courseRetainUntil(c, input.courseId),
        // Facts about the export, never its content.
        summary: { kind: input.kind, format: input.format, rows: model.table.rows.length },
      });
      return rows[0]!.expires_at;
    });
    return {
      id,
      filename,
      format: input.format,
      kind: input.kind,
      rowCount: model.table.rows.length,
      expiresAt: iso(expiresAt),
      downloadPath: `/exports/${id}/download`,
    };
  } catch (err) {
    await storage.delete(storageKey).catch(() => undefined); // never leave an unrecorded file behind
    throw err;
  }
}

export interface Download {
  data: Buffer;
  filename: string;
  contentType: string;
}

/**
 * Only the lecturer who requested an export, and only while they are still assigned to the course
 * and the file has not expired. Everything else looks like "not found".
 */
export async function downloadExport(
  pool: pg.Pool,
  storage: ExportStorage,
  input: { exportId: string; actorId: string },
): Promise<Download> {
  const { rows } = await pool.query<{
    id: string;
    course_id: string;
    session_id: string | null;
    report_kind: ReportKind;
    format: ExportFormat;
    status: string;
    storage_key: string | null;
    filename: string;
    live: boolean;
  }>(
    `SELECT e.id, e.course_id, e.session_id, e.report_kind::text AS report_kind, e.format::text AS format,
            e.status::text AS status, e.storage_key, e.params->>'filename' AS filename,
            (e.expires_at > clock_timestamp()) AS live
       FROM export_records e
       JOIN lecturer_courses lc ON lc.course_id = e.course_id AND lc.lecturer_id = $2 AND lc.ended_at IS NULL
      WHERE e.id = $1 AND e.requested_by = $2`,
    [input.exportId, input.actorId],
  );
  const rec = rows[0];
  if (!rec) throw new ExportError(404, 'NOT_FOUND', 'Not found.');
  if (rec.status === 'EXPIRED' || !rec.live || !rec.storage_key) {
    throw new ExportError(410, 'EXPORT_EXPIRED', 'This export has expired. Create it again.');
  }

  let data: Buffer;
  try {
    data = await storage.get(rec.storage_key);
  } catch {
    throw new ExportError(410, 'EXPORT_EXPIRED', 'This export has expired. Create it again.');
  }

  await writeAudit(pool, {
    class: 'DOMAIN',
    actorType: 'LECTURER',
    actorUserId: input.actorId,
    action: 'EXPORT_DOWNLOADED',
    courseId: rec.course_id,
    sessionId: rec.session_id,
    entityType: 'export',
    entityId: rec.id,
    retainUntil: await courseRetainUntil(pool, rec.course_id),
    summary: { kind: rec.report_kind, format: rec.format },
  });
  return { data, filename: rec.filename, contentType: FORMATS[rec.format].contentType };
}

export async function listExports(pool: pg.Pool, courseId: string, actorId: string) {
  const { rows } = await pool.query<{
    id: string;
    format: string;
    report_kind: string;
    status: string;
    row_count: number | null;
    filename: string;
    expires_at: Date | null;
    live: boolean;
  }>(
    `SELECT id, format::text AS format, report_kind::text AS report_kind, status::text AS status, row_count,
            params->>'filename' AS filename, expires_at, (expires_at > clock_timestamp()) AS live
       FROM export_records
      WHERE course_id = $1 AND requested_by = $2
      ORDER BY requested_at DESC LIMIT 20`,
    [courseId, actorId],
  );
  return rows.map((r) => ({
    id: r.id,
    format: r.format,
    kind: r.report_kind,
    rowCount: r.row_count,
    filename: r.filename,
    status: r.status === 'READY' && !r.live ? 'EXPIRED' : r.status,
    expiresAt: r.expires_at ? iso(r.expires_at) : null,
    downloadPath: r.status === 'READY' && r.live ? `/exports/${r.id}/download` : null,
  }));
}

/** Deletes the files of expired exports and marks them. Safe to run repeatedly and on several instances. */
export async function expireExports(
  pool: pg.Pool,
  storage: ExportStorage,
  batch = 100,
): Promise<number> {
  const { rows } = await pool.query<{ id: string; storage_key: string; course_id: string }>(
    `SELECT id, storage_key, course_id FROM export_records
      WHERE status = 'READY' AND expires_at <= clock_timestamp()
      ORDER BY expires_at LIMIT $1`,
    [batch],
  );
  let expired = 0;
  for (const r of rows) {
    await storage.delete(r.storage_key); // file first: a failure here leaves the record to retry
    await withTransaction(pool, async (c) => {
      const result = await c.query(
        `UPDATE export_records SET status = 'EXPIRED', storage_key = NULL WHERE id = $1 AND status = 'READY'`,
        [r.id],
      );
      if (result.rowCount === 1) {
        expired += 1;
        await writeAudit(c, {
          class: 'DOMAIN',
          actorType: 'SYSTEM',
          action: 'EXPORT_EXPIRED',
          courseId: r.course_id,
          entityType: 'export',
          entityId: r.id,
          retainUntil: await courseRetainUntil(c, r.course_id),
        });
      }
    });
  }
  return expired;
}

export function startExportExpiry(
  pool: pg.Pool,
  storage: ExportStorage,
  onError: (e: unknown) => void,
  everyMs = 5 * 60_000,
): () => void {
  let running = false;
  const timer = setInterval(() => {
    if (running) return;
    running = true;
    expireExports(pool, storage)
      .catch(onError)
      .finally(() => {
        running = false;
      });
  }, everyMs);
  timer.unref();
  return () => clearInterval(timer);
}

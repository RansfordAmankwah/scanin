import type { Db } from './db/pool.js';

export type AuditClass = 'DOMAIN' | 'SECURITY';
export type AuditActorType = 'LECTURER' | 'STUDENT' | 'SYSTEM' | 'OPERATOR' | 'ANONYMOUS';

export interface AuditInput {
  class: AuditClass;
  actorType: AuditActorType;
  actorUserId?: string | null;
  action: string;
  outcome?: 'SUCCESS' | 'DENIED';
  courseId?: string | null;
  sessionId?: string | null;
  entityType?: string | null;
  entityId?: string | null;
  requestId?: string | null;
  /** Whitelisted, non-secret facts only: ids, counts, hashes. Never tokens or credentials. */
  summary?: Record<string, unknown>;
  ipHash?: Buffer | null;
  /** Required for DOMAIN events (term end + 1 year). SECURITY events default to 90 days. */
  retainUntil?: string | null;
}

/** Appends an audit event. Pass a transaction client to make it atomic with the change it records. */
export async function writeAudit(db: Db, e: AuditInput): Promise<void> {
  if (e.class === 'DOMAIN' && !e.retainUntil) {
    throw new Error('DOMAIN audit events must carry retainUntil');
  }
  await db.query(
    `INSERT INTO audit_events
       (class, actor_type, actor_user_id, action, outcome, course_id, session_id,
        entity_type, entity_id, request_id, summary, ip_hash, retain_until)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12,
             COALESCE($13::date, current_date + 90))`,
    [
      e.class,
      e.actorType,
      e.actorUserId ?? null,
      e.action,
      e.outcome ?? 'SUCCESS',
      e.courseId ?? null,
      e.sessionId ?? null,
      e.entityType ?? null,
      e.entityId ?? null,
      e.requestId ?? null,
      JSON.stringify(e.summary ?? {}),
      e.ipHash ?? null,
      e.retainUntil ?? null,
    ],
  );
}

/** Retention end for course-related DOMAIN events: the term's end date plus one year (provisional). */
export async function courseRetainUntil(db: Db, courseId: string): Promise<string> {
  const { rows } = await db.query<{ retain_until: string }>(
    `SELECT to_char(t.ends_on + interval '1 year', 'YYYY-MM-DD') AS retain_until
       FROM courses c JOIN terms t ON t.id = c.term_id WHERE c.id = $1`,
    [courseId],
  );
  const value = rows[0]?.retain_until;
  if (!value) throw new Error('course not found for audit retention');
  return value;
}

import type { Role } from '@scanin/shared';
import type { Db } from '../db/pool.js';
import { randomToken, sha256 } from './crypto.js';

/** Provisional lifetimes (seconds); to be confirmed against university policy. */
export const SESSION_POLICY: Record<Role, { idleSeconds: number; absoluteSeconds: number }> = {
  LECTURER: { idleSeconds: 2 * 3600, absoluteSeconds: 12 * 3600 },
  STUDENT: { idleSeconds: 7 * 86400, absoluteSeconds: 30 * 86400 },
};

/** Sliding idle expiry is only written back at most this often, to avoid a write per request. */
const TOUCH_INTERVAL_SECONDS = 60;

export interface AuthContext {
  sessionHash: Buffer;
  userId: string;
  role: Role;
  fullName: string;
  emailVerified: boolean;
  /** The signed-in user's own e-mail and, for a student, student ID. Shown only to them. */
  email: string;
  studentId: string | null;
}

export interface NewSession {
  token: string;
  maxAgeSeconds: number;
}

/** Creates a session with a fresh random token; the client never chooses its own session id. */
export async function createSession(db: Db, userId: string, role: Role): Promise<NewSession> {
  const token = randomToken();
  const policy = SESSION_POLICY[role];
  await db.query(
    `INSERT INTO auth_sessions (id_hash, user_id, idle_expires_at, absolute_expires_at)
     VALUES ($1, $2,
             clock_timestamp() + make_interval(secs => $3),
             clock_timestamp() + make_interval(secs => $4))`,
    [sha256(token), userId, policy.idleSeconds, policy.absoluteSeconds],
  );
  return { token, maxAgeSeconds: policy.absoluteSeconds };
}

/** Resolves a cookie token to a live session and user, sliding the idle expiry. */
export async function findSession(db: Db, token: string): Promise<AuthContext | null> {
  const hash = sha256(token);
  const { rows } = await db.query<{
    user_id: string;
    role: Role;
    full_name: string;
    email_verified_at: Date | null;
    email: string;
    student_id_display: string | null;
    since_seen_s: number;
  }>(
    `SELECT u.id AS user_id, u.role, u.full_name, u.email_verified_at, u.email::text AS email, u.student_id_display,
            extract(epoch FROM (clock_timestamp() - s.last_seen_at))::float AS since_seen_s
       FROM auth_sessions s
       JOIN users u ON u.id = s.user_id
      WHERE s.id_hash = $1
        AND s.revoked_at IS NULL
        AND s.idle_expires_at > clock_timestamp()
        AND s.absolute_expires_at > clock_timestamp()
        AND u.status = 'ACTIVE'`,
    [hash],
  );
  const row = rows[0];
  if (!row) return null;

  if (row.since_seen_s > TOUCH_INTERVAL_SECONDS) {
    const policy = SESSION_POLICY[row.role];
    await db.query(
      `UPDATE auth_sessions
          SET last_seen_at = clock_timestamp(),
              idle_expires_at = LEAST(clock_timestamp() + make_interval(secs => $2), absolute_expires_at)
        WHERE id_hash = $1`,
      [hash, policy.idleSeconds],
    );
  }

  return {
    sessionHash: hash,
    userId: row.user_id,
    role: row.role,
    fullName: row.full_name,
    emailVerified: row.email_verified_at !== null,
    email: row.email,
    studentId: row.student_id_display,
  };
}

export async function revokeSession(db: Db, sessionHash: Buffer, reason: string): Promise<void> {
  await db.query(
    `UPDATE auth_sessions SET revoked_at = clock_timestamp(), revoke_reason = $2
      WHERE id_hash = $1 AND revoked_at IS NULL`,
    [sessionHash, reason],
  );
}

/** Revokes every live session of a user (e.g. after a password change). */
export async function revokeAllSessions(db: Db, userId: string, reason: string): Promise<number> {
  const result = await db.query(
    `UPDATE auth_sessions SET revoked_at = clock_timestamp(), revoke_reason = $2
      WHERE user_id = $1 AND revoked_at IS NULL`,
    [userId, reason],
  );
  return result.rowCount ?? 0;
}

import { createHash, randomBytes } from 'node:crypto';
import type { MigratedTestDatabase } from './testDb.js';

export interface BulkStudent {
  id: string;
  studentId: string;
  email: string;
  /** Ready-to-send Cookie header value for a signed-in session. */
  cookie: string;
}

let seq = 0;

/**
 * Creates many students with live sessions directly in the database (the owner connection), so
 * concurrency tests do not spend their time hashing passwords. Never used for auth tests.
 */
export async function createBulkStudents(
  db: MigratedTestDatabase,
  count: number,
): Promise<BulkStudent[]> {
  const batch = `${Date.now().toString(36)}${(seq += 1)}`;
  const students = Array.from({ length: count }, (_, i) => ({
    studentId: `BK${batch}${String(i).padStart(4, '0')}`.toUpperCase(),
    email: `bulk-${batch}-${i}@school.test`,
    token: randomBytes(24).toString('base64url'),
  }));

  const { rows } = await db.pool.query<{ id: string; student_id_norm: string }>(
    `INSERT INTO users (role, email, full_name, student_id_norm, student_id_display, password_hash)
     SELECT 'STUDENT', e, 'Bulk Student', s, s, 'unused'
       FROM unnest($1::text[], $2::text[]) AS t(e, s)
     RETURNING id, student_id_norm`,
    [students.map((s) => s.email), students.map((s) => s.studentId)],
  );
  const idByStudentId = new Map(rows.map((r) => [r.student_id_norm, r.id]));

  await db.pool.query(
    `INSERT INTO auth_sessions (id_hash, user_id, idle_expires_at, absolute_expires_at)
     SELECT h, u, now() + interval '1 day', now() + interval '2 days'
       FROM unnest($1::bytea[], $2::uuid[]) AS t(h, u)`,
    [
      students.map((s) => createHash('sha256').update(s.token).digest()),
      students.map((s) => idByStudentId.get(s.studentId)),
    ],
  );

  return students.map((s) => ({
    id: idByStudentId.get(s.studentId) as string,
    studentId: s.studentId,
    email: s.email,
    cookie: `__Host-sid=${s.token}`,
  }));
}

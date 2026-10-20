import type pg from 'pg';

/**
 * Retention (provisional defaults; the university's policy and applicable privacy law take
 * precedence):
 *   scan metadata ........................ 90 days from the scan
 *   security audit events ................ 90 days (their own retain_until)
 *   auth sessions / account tokens ....... 7 days after expiry, use or revocation
 *   rate-limit counters .................. 1 day
 *   a course and everything about it ..... term end + 1 year
 *   student accounts with nothing left ... 12 months without activity
 *
 * Every rule is a pure function of data dates and the database clock, never of "what ran last".
 * So restoring an old backup and running the job again deletes exactly what has expired by then;
 * a deleted record cannot stay alive just because it is in a backup that is later restored.
 *
 * Runs as the dedicated `retention` database role: it can read and delete, and nothing else.
 */
export const SCAN_METADATA_DAYS = 90;
export const SESSION_CLEANUP_DAYS = 7;
export const INACTIVE_ACCOUNT_MONTHS = 12;
// Grace between a self-requested deletion and the irreversible erase. The account is disabled
// immediately when requested; this window is a safety buffer against mistaken or hostile requests.
export const ACCOUNT_DELETION_GRACE_DAYS = 7;

export interface RetentionReport {
  scanAttempts: number;
  faceDetail: number;
  securityAudit: number;
  authSessions: number;
  accountTokens: number;
  rateLimits: number;
  coursesPurged: number;
  termsPurged: number;
  accountsPurged: number;
  accountsDeleted: number;
}

async function deleteInBatches(
  pool: pg.Pool,
  sql: string,
  params: unknown[] = [],
  batch = 5000,
): Promise<number> {
  // `sql` is "DELETE FROM t WHERE ctid IN (SELECT ctid FROM t WHERE ... LIMIT $n)": bounded locks.
  let total = 0;
  for (;;) {
    const r = await pool.query(sql, [...params, batch]);
    total += r.rowCount ?? 0;
    if ((r.rowCount ?? 0) < batch) return total;
  }
}

/** Deletes a whole course and everything that hangs off it, in dependency order, atomically. */
export async function purgeCourse(pool: pg.Pool, courseId: string): Promise<void> {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const p = [courseId];
    await c.query('DELETE FROM export_records WHERE course_id = $1', p);
    await c.query('DELETE FROM audit_events WHERE course_id = $1', p);
    // Face enrollment sessions are course-scoped. Enrollments and consent are student-global (one
    // template per person) and are removed on withdrawal, not with a single course.
    await c.query('DELETE FROM face_enrollment_sessions WHERE course_id = $1', p);
    // Face checks: detail, then events, then challenges (children before parents, before attendance).
    await c.query(
      'DELETE FROM face_check_details WHERE event_id IN (SELECT id FROM attendance_face_check_events WHERE course_id = $1)',
      p,
    );
    await c.query('DELETE FROM attendance_face_check_events WHERE course_id = $1', p);
    await c.query('DELETE FROM face_check_challenges WHERE course_id = $1', p);
    // Anti-proxy records, children first (events, then their parents), before attendance and sessions.
    await c.query(
      'DELETE FROM attendance_dispute_events WHERE dispute_id IN (SELECT id FROM attendance_disputes WHERE course_id = $1)',
      p,
    );
    await c.query('DELETE FROM attendance_disputes WHERE course_id = $1', p);
    await c.query(
      'DELETE FROM spot_check_events WHERE item_id IN (SELECT id FROM spot_check_items WHERE course_id = $1)',
      p,
    );
    await c.query('DELETE FROM spot_check_items WHERE course_id = $1', p);
    await c.query('DELETE FROM spot_checks WHERE course_id = $1', p);
    await c.query('DELETE FROM reconciliation_notes WHERE course_id = $1', p);
    await c.query('DELETE FROM session_headcounts WHERE course_id = $1', p);
    await c.query(
      'DELETE FROM device_sessions WHERE session_id IN (SELECT id FROM class_sessions WHERE course_id = $1)',
      p,
    );
    await c.query(
      'DELETE FROM scan_attempts WHERE session_id IN (SELECT id FROM class_sessions WHERE course_id = $1)',
      p,
    );
    await c.query(
      'DELETE FROM investigation_flag_events WHERE flag_id IN (SELECT id FROM investigation_flags WHERE course_id = $1)',
      p,
    );
    await c.query(
      'DELETE FROM identity_reviews WHERE link_id IN (SELECT id FROM roster_links WHERE course_id = $1)',
      p,
    );
    await c.query('DELETE FROM investigation_flags WHERE course_id = $1', p);
    await c.query(
      'DELETE FROM attendance_revisions WHERE attendance_id IN (SELECT id FROM attendance_records WHERE course_id = $1)',
      p,
    );
    await c.query('DELETE FROM attendance_records WHERE course_id = $1', p);
    await c.query('DELETE FROM roster_links WHERE course_id = $1', p);
    await c.query('DELETE FROM roster_entries WHERE course_id = $1', p);
    await c.query('DELETE FROM roster_imports WHERE course_id = $1', p);
    await c.query(
      'DELETE FROM session_extensions WHERE session_id IN (SELECT id FROM class_sessions WHERE course_id = $1)',
      p,
    );
    await c.query('DELETE FROM class_sessions WHERE course_id = $1', p);
    await c.query('DELETE FROM lecturer_courses WHERE course_id = $1', p);
    await c.query('DELETE FROM courses WHERE id = $1', p);
    await c.query('COMMIT');
  } catch (err) {
    await c.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    c.release();
  }
}

/**
 * Student accounts that have nothing left that needs them and have been idle for a year. Anything
 * still referenced (attendance, audit events, matches...) simply stays: the foreign keys decide,
 * and each candidate is tried on its own so one referenced account cannot block the rest.
 */
async function purgeInactiveAccounts(pool: pg.Pool): Promise<number> {
  const { rows } = await pool.query<{ id: string }>(
    `SELECT u.id FROM users u
      WHERE u.role = 'STUDENT'
        AND u.created_at < clock_timestamp() - make_interval(months => $1)
        AND NOT EXISTS (SELECT 1 FROM auth_sessions s WHERE s.user_id = u.id AND s.last_seen_at > clock_timestamp() - make_interval(months => $1))
      ORDER BY u.created_at
      LIMIT 500`,
    [INACTIVE_ACCOUNT_MONTHS],
  );
  let removed = 0;
  for (const { id } of rows) {
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await c.query('DELETE FROM device_sessions WHERE student_id = $1', [id]);
      await c.query('DELETE FROM auth_sessions WHERE user_id = $1', [id]);
      await c.query('DELETE FROM account_tokens WHERE user_id = $1', [id]);
      await c.query('DELETE FROM users WHERE id = $1', [id]);
      await c.query('COMMIT');
      removed += 1;
    } catch (err) {
      await c.query('ROLLBACK').catch(() => undefined);
      if ((err as { code?: string }).code !== '23503') throw err; // still referenced: keep
    } finally {
      c.release();
    }
  }
  return removed;
}

/**
 * Erases student accounts that asked to be deleted and have passed the grace period. Each account
 * is removed with all of its own data, in dependency order, in one transaction. Only self-service
 * STUDENT deletions reach this (lecturer accounts own shared course data and are handled elsewhere),
 * so none of the lecturer-only back-references apply; a 23503 still means something unexpected
 * references the account, in which case it is left in place rather than half-deleted.
 */
async function purgeDeletedAccounts(pool: pg.Pool, graceDays: number): Promise<number> {
  const { rows } = await pool.query<{ id: string }>(
    `SELECT id FROM users
      WHERE deletion_requested_at IS NOT NULL
        AND deletion_requested_at < clock_timestamp() - make_interval(days => $1)
      ORDER BY deletion_requested_at
      LIMIT 500`,
    [graceDays],
  );
  let removed = 0;
  for (const { id } of rows) {
    const c = await pool.connect();
    const p = [id];
    try {
      await c.query('BEGIN');
      // Face checks: detail, then events, then challenges (children before attendance).
      await c.query(
        `DELETE FROM face_check_details WHERE event_id IN (
           SELECT id FROM attendance_face_check_events
            WHERE student_id = $1 OR attendance_id IN (SELECT id FROM attendance_records WHERE student_id = $1))`,
        p,
      );
      await c.query(
        `DELETE FROM attendance_face_check_events
          WHERE student_id = $1 OR attendance_id IN (SELECT id FROM attendance_records WHERE student_id = $1)`,
        p,
      );
      await c.query(
        `DELETE FROM face_check_challenges
          WHERE student_id = $1 OR attendance_id IN (SELECT id FROM attendance_records WHERE student_id = $1)`,
        p,
      );
      // Disputes: events before parents.
      await c.query(
        `DELETE FROM attendance_dispute_events
          WHERE actor_user_id = $1 OR dispute_id IN (
            SELECT id FROM attendance_disputes
             WHERE student_id = $1 OR resolved_by = $1
                OR attendance_id IN (SELECT id FROM attendance_records WHERE student_id = $1)
                OR source_item_id IN (SELECT id FROM spot_check_items WHERE student_id = $1))`,
        p,
      );
      await c.query(
        `DELETE FROM attendance_disputes
          WHERE student_id = $1 OR resolved_by = $1
             OR attendance_id IN (SELECT id FROM attendance_records WHERE student_id = $1)
             OR source_item_id IN (SELECT id FROM spot_check_items WHERE student_id = $1)`,
        p,
      );
      // Spot checks: events before items.
      await c.query(
        `DELETE FROM spot_check_events
          WHERE actor_user_id = $1 OR item_id IN (
            SELECT id FROM spot_check_items
             WHERE student_id = $1 OR attendance_id IN (SELECT id FROM attendance_records WHERE student_id = $1))`,
        p,
      );
      await c.query(
        `DELETE FROM spot_check_items
          WHERE student_id = $1 OR attendance_id IN (SELECT id FROM attendance_records WHERE student_id = $1)`,
        p,
      );
      // Flags and reviews: reviews that point at a flag, then flag events, then flags.
      await c.query(
        `DELETE FROM identity_reviews
          WHERE actor_user_id = $1 OR link_id IN (SELECT id FROM roster_links WHERE student_id = $1)`,
        p,
      );
      await c.query(
        `DELETE FROM investigation_flag_events
          WHERE actor_user_id = $1 OR flag_id IN (
            SELECT id FROM investigation_flags
             WHERE raised_by = $1
                OR attendance_id IN (SELECT id FROM attendance_records WHERE student_id = $1)
                OR roster_link_id IN (SELECT id FROM roster_links WHERE student_id = $1)
                OR related_link_id IN (SELECT id FROM roster_links WHERE student_id = $1))`,
        p,
      );
      await c.query(
        `DELETE FROM investigation_flags
          WHERE raised_by = $1
             OR attendance_id IN (SELECT id FROM attendance_records WHERE student_id = $1)
             OR roster_link_id IN (SELECT id FROM roster_links WHERE student_id = $1)
             OR related_link_id IN (SELECT id FROM roster_links WHERE student_id = $1)`,
        p,
      );
      // Attendance history, scans, then the records.
      await c.query(
        `DELETE FROM scan_attempts
          WHERE student_id = $1 OR attendance_id IN (SELECT id FROM attendance_records WHERE student_id = $1)`,
        p,
      );
      await c.query(
        `DELETE FROM attendance_revisions
          WHERE actor_user_id = $1 OR attendance_id IN (SELECT id FROM attendance_records WHERE student_id = $1)`,
        p,
      );
      await c.query('DELETE FROM attendance_records WHERE student_id = $1', p);
      // Roster links, devices, face enrollment and consent.
      await c.query('DELETE FROM roster_links WHERE student_id = $1', p);
      await c.query('DELETE FROM device_sessions WHERE student_id = $1', p);
      await c.query(
        'DELETE FROM face_enrollment_sessions WHERE student_id = $1 OR created_by = $1',
        p,
      );
      await c.query('DELETE FROM face_enrollments WHERE student_id = $1 OR supervised_by = $1', p);
      await c.query('DELETE FROM biometric_consent_events WHERE student_id = $1', p);
      // Auth, tokens, and this account's own security trail (retention cannot null columns).
      await c.query('DELETE FROM auth_sessions WHERE user_id = $1', p);
      await c.query('DELETE FROM account_tokens WHERE user_id = $1', p);
      await c.query('DELETE FROM audit_events WHERE actor_user_id = $1', p);
      await c.query('DELETE FROM users WHERE id = $1', p);
      await c.query('COMMIT');
      removed += 1;
    } catch (err) {
      await c.query('ROLLBACK').catch(() => undefined);
      if ((err as { code?: string }).code !== '23503') throw err; // unexpectedly referenced: keep
    } finally {
      c.release();
    }
  }
  return removed;
}

export async function runRetention(
  pool: pg.Pool,
  opts: { faceDetailDays?: number } = {},
): Promise<RetentionReport> {
  const faceDetailDays = opts.faceDetailDays ?? 90;
  // Liveness and match-score detail is deleted after the retention window; the outcome stays.
  const faceDetail = await deleteInBatches(
    pool,
    `DELETE FROM face_check_details WHERE ctid IN (
       SELECT ctid FROM face_check_details WHERE at < clock_timestamp() - make_interval(days => $1) LIMIT $2)`,
    [faceDetailDays],
  );
  // Expired, unused challenges are ephemeral; clear them on the same pass.
  await deleteInBatches(
    pool,
    `DELETE FROM face_check_challenges WHERE ctid IN (
       SELECT ctid FROM face_check_challenges WHERE expires_at < clock_timestamp() - interval '1 day' AND used_at IS NULL LIMIT $1)`,
  );
  const scanAttempts = await deleteInBatches(
    pool,
    `DELETE FROM scan_attempts WHERE ctid IN (
       SELECT ctid FROM scan_attempts WHERE received_at < clock_timestamp() - make_interval(days => ${SCAN_METADATA_DAYS}) LIMIT $1)`,
  );
  // Device-binding rows are scan metadata too: same 90-day window, folded into the same count.
  const deviceRows = await deleteInBatches(
    pool,
    `DELETE FROM device_sessions WHERE ctid IN (
       SELECT ctid FROM device_sessions WHERE created_at < clock_timestamp() - make_interval(days => ${SCAN_METADATA_DAYS}) LIMIT $1)`,
  );
  const securityAudit = await deleteInBatches(
    pool,
    `DELETE FROM audit_events WHERE ctid IN (
       SELECT ctid FROM audit_events WHERE class = 'SECURITY' AND retain_until < current_date LIMIT $1)`,
  );
  const authSessions = await deleteInBatches(
    pool,
    `DELETE FROM auth_sessions WHERE ctid IN (
       SELECT ctid FROM auth_sessions
        WHERE LEAST(absolute_expires_at, COALESCE(revoked_at, absolute_expires_at)) < clock_timestamp() - make_interval(days => ${SESSION_CLEANUP_DAYS})
           OR idle_expires_at < clock_timestamp() - make_interval(days => ${SESSION_CLEANUP_DAYS})
        LIMIT $1)`,
  );
  const accountTokens = await deleteInBatches(
    pool,
    `DELETE FROM account_tokens WHERE ctid IN (
       SELECT ctid FROM account_tokens
        WHERE LEAST(expires_at, COALESCE(used_at, expires_at)) < clock_timestamp() - make_interval(days => ${SESSION_CLEANUP_DAYS})
        LIMIT $1)`,
  );
  const rateLimits = await deleteInBatches(
    pool,
    `DELETE FROM rate_limits WHERE ctid IN (
       SELECT ctid FROM rate_limits WHERE window_start < clock_timestamp() - interval '1 day' LIMIT $1)`,
  );

  // A course is kept through the last day of (term end + 1 year) and purged the day after.
  const due = await pool.query<{ id: string }>(
    `SELECT c.id FROM courses c JOIN terms t ON t.id = c.term_id
      WHERE t.ends_on + interval '1 year' < current_date`,
  );
  for (const { id } of due.rows) await purgeCourse(pool, id);

  const terms = await pool.query(
    `DELETE FROM terms t WHERE t.ends_on + interval '1 year' < current_date
        AND NOT EXISTS (SELECT 1 FROM courses c WHERE c.term_id = t.id)`,
  );
  const accountsDeleted = await purgeDeletedAccounts(pool, ACCOUNT_DELETION_GRACE_DAYS);
  const accountsPurged = await purgeInactiveAccounts(pool);

  return {
    scanAttempts: scanAttempts + deviceRows,
    faceDetail,
    securityAudit,
    authSessions,
    accountTokens,
    rateLimits,
    coursesPurged: due.rows.length,
    termsPurged: terms.rowCount ?? 0,
    accountsPurged,
    accountsDeleted,
  };
}

/** Runs retention daily. Safe on several instances: each rule is idempotent. */
export function startRetentionJob(
  pool: pg.Pool,
  onResult: (r: RetentionReport) => void,
  onError: (e: unknown) => void,
  everyMs = 24 * 3600_000,
): () => void {
  let running = false;
  const run = () => {
    if (running) return;
    running = true;
    runRetention(pool)
      .then(onResult)
      .catch(onError)
      .finally(() => {
        running = false;
      });
  };
  const first = setTimeout(run, 60_000); // shortly after start, then daily
  const timer = setInterval(run, everyMs);
  first.unref();
  timer.unref();
  return () => {
    clearTimeout(first);
    clearInterval(timer);
  };
}

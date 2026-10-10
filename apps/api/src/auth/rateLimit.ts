import type { Db } from '../db/pool.js';
import { sha256 } from './crypto.js';

/**
 * Fixed-window counters kept in PostgreSQL, so several API instances share one view.
 * A window is `windowSeconds` long and aligned to the epoch.
 */
function windowStartSql(): string {
  return `to_timestamp(floor(extract(epoch FROM clock_timestamp()) / $2) * $2)`;
}

export interface WindowState {
  count: number;
  retryAfterSeconds: number;
}

/** Current count in this window, without incrementing. */
export async function peek(db: Db, key: string, windowSeconds: number): Promise<WindowState> {
  const { rows } = await db.query<{ count: number; retry_after: number }>(
    `SELECT COALESCE(max(count), 0)::int AS count,
            ceil($2 - mod(extract(epoch FROM clock_timestamp()), $2))::int AS retry_after
       FROM rate_limits
      WHERE key_hash = $1 AND window_start = ${windowStartSql()}`,
    [sha256(key), windowSeconds],
  );
  const row = rows[0];
  return { count: row?.count ?? 0, retryAfterSeconds: row?.retry_after ?? windowSeconds };
}

/** Increments the counter for this window and returns the new state. */
export async function hit(db: Db, key: string, windowSeconds: number): Promise<WindowState> {
  const { rows } = await db.query<{ count: number; retry_after: number }>(
    `INSERT INTO rate_limits (key_hash, window_start, count)
     VALUES ($1, ${windowStartSql()}, 1)
     ON CONFLICT (key_hash, window_start) DO UPDATE SET count = rate_limits.count + 1
     RETURNING count,
               ceil($2 - mod(extract(epoch FROM clock_timestamp()), $2))::int AS retry_after`,
    [sha256(key), windowSeconds],
  );
  const row = rows[0];
  if (!row) throw new Error('rate limit upsert returned no row');
  return { count: row.count, retryAfterSeconds: row.retry_after };
}

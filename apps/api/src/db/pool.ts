import pg from 'pg';

/** A pool or a checked-out client: anything that can run a query. */
export type Db = Pick<pg.Pool, 'query'>;

export function createPool(connectionString: string): pg.Pool {
  return hardenPool(new pg.Pool({ connectionString, max: 10 }));
}

/**
 * A connection can die while checked out (database restart, failover, an administrator killing it).
 * The query in flight then rejects, which our code handles, but the driver ALSO emits an 'error'
 * event on the connection, and an event with no listener is an uncaught exception that would crash
 * the whole process. Listening is enough: the pool discards broken connections itself.
 */
export function hardenPool(pool: pg.Pool): pg.Pool {
  pool.on('connect', (client) => {
    client.on('error', () => undefined);
  });
  pool.on('error', () => undefined); // idle connections that fail
  return pool;
}

/** Runs `fn` in a transaction and commits, or rolls back if it throws. */
export async function withTransaction<T>(
  pool: pg.Pool,
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

/** True for a PostgreSQL unique violation, optionally on a specific constraint. */
export function isUniqueViolation(err: unknown, constraint?: string): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const e = err as { code?: string; constraint?: string };
  return e.code === '23505' && (constraint === undefined || e.constraint === constraint);
}

/**
 * Errors worth retrying with a fresh transaction: serialization failure, deadlock, lock timeout,
 * statement timeout, connection loss, admin shutdown, too many connections.
 */
const TRANSIENT_CODES = new Set([
  '40001',
  '40P01',
  '55P03',
  '57014',
  '57P01',
  '53300',
  '08000',
  '08003',
  '08006',
]);

export function isTransientDbError(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const e = err as { code?: string; message?: string };
  if (e.code && (TRANSIENT_CODES.has(e.code) || e.code.startsWith('08'))) return true;
  // The pg driver reports a dropped connection without a SQLSTATE.
  return /connection terminated|connection refused|ECONNRESET|timeout exceeded when trying to connect/i.test(
    e.message ?? '',
  );
}

export class TransientDbError extends Error {
  constructor(cause: unknown) {
    super('The database is temporarily unavailable.', { cause });
  }
}

/**
 * Runs `fn` (which must open its own transaction) again, from scratch, when it fails with a
 * transient database error. Only safe for operations that are idempotent by construction.
 */
export async function withRetry<T>(fn: () => Promise<T>, attempts = 3): Promise<T> {
  let last: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      if (!isTransientDbError(err)) throw err;
      last = err;
      if (i < attempts - 1)
        await new Promise((r) => setTimeout(r, 25 + Math.random() * 75 * (i + 1)));
    }
  }
  throw new TransientDbError(last);
}

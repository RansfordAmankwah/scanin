import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type pg from 'pg';

export const DEFAULT_MIGRATIONS_DIR = fileURLToPath(
  new URL('../../../../db/migrations', import.meta.url),
);
export const DEFAULT_GRANTS_FILE = fileURLToPath(
  new URL('../../../../db/grants.sql', import.meta.url),
);

// Arbitrary constant: serialises concurrent migrators on the same database.
const MIGRATION_LOCK_KEY = 727_001;

const MIGRATION_FILE = /^\d{4}_[a-z0-9_]+\.sql$/;

export interface AppliedMigration {
  name: string;
  checksum: string;
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/**
 * Applies every pending .sql file in `dir`, in filename order, each inside its own transaction.
 * Already-applied files are verified by checksum so history cannot be silently edited.
 * Returns the names applied during this call.
 */
export async function migrate(
  pool: pg.Pool,
  dir: string = DEFAULT_MIGRATIONS_DIR,
): Promise<string[]> {
  const client = await pool.connect();
  const applied: string[] = [];
  try {
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_KEY]);
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name       text PRIMARY KEY,
        checksum   text NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT clock_timestamp()
      )`);

    const { rows } = await client.query<AppliedMigration>(
      'SELECT name, checksum FROM schema_migrations',
    );
    const done = new Map(rows.map((r) => [r.name, r.checksum]));

    const files = (await readdir(dir)).filter((f) => MIGRATION_FILE.test(f)).sort();
    for (const file of files) {
      const sql = await readFile(`${dir}/${file}`, 'utf8');
      const checksum = sha256(sql);
      const previous = done.get(file);
      if (previous !== undefined) {
        if (previous !== checksum) {
          throw new Error(`Migration ${file} was modified after it was applied`);
        }
        continue;
      }
      try {
        await client.query('BEGIN');
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)', [
          file,
          checksum,
        ]);
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`Migration ${file} failed: ${(err as Error).message}`, { cause: err });
      }
      applied.push(file);
    }
  } finally {
    await client
      .query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_KEY])
      .catch(() => undefined);
    client.release();
  }
  return applied;
}

const ROLE_NAME = /^[a-z_][a-z0-9_]{0,62}$/;

function quoteRole(name: string): string {
  if (!ROLE_NAME.test(name)) {
    throw new Error(`Unsafe role name: ${name}`);
  }
  return `"${name}"`;
}

export interface GrantRoles {
  appRole: string;
  retentionRole: string;
}

/** (Re)applies db/grants.sql for the given roles. Safe to run repeatedly. */
export async function applyGrants(
  pool: pg.Pool,
  roles: GrantRoles,
  file: string = DEFAULT_GRANTS_FILE,
): Promise<void> {
  const template = await readFile(file, 'utf8');
  const sql = template
    .replaceAll('{{app}}', quoteRole(roles.appRole))
    .replaceAll('{{retention}}', quoteRole(roles.retentionRole));
  await pool.query(sql);
}

import pg from 'pg';
import { applyGrants, migrate } from './migrate.js';

/**
 * Prepares a database for ScanIn: applies migrations and (re)installs the least-privilege grants.
 * Safe to run on every deploy. Uses a connection that OWNS the schema (the "migrator"); the running
 * application never connects as this role.
 *
 *   MIGRATOR_DATABASE_URL     owner connection (required)
 *   DB_APP_ROLE               role the API runs as            (default scanin_app)
 *   DB_RETENTION_ROLE         role for the purge job          (default scanin_retention)
 *   DB_OPERATOR_ROLE          role for the operator CLI       (default scanin_operator)
 *   DB_<...>_PASSWORD         with --create-roles: give each role a login password
 *
 * `--create-roles` creates any missing role (for a fresh database or CI). In a managed cloud
 * database the roles are normally created once by whoever administers it, with passwords from the
 * secrets manager, and this tool then only migrates and grants.
 */
export interface SetupOptions {
  url: string;
  appRole: string;
  retentionRole: string;
  operatorRole: string;
  createRoles?: boolean;
  passwords?: Partial<Record<'app' | 'retention' | 'operator', string>>;
}

const ROLE_NAME = /^[a-z_][a-z0-9_]{0,62}$/;

export async function runSetup(opts: SetupOptions): Promise<{ migrations: string[] }> {
  for (const r of [opts.appRole, opts.retentionRole, opts.operatorRole]) {
    if (!ROLE_NAME.test(r)) throw new Error(`Unsafe role name: ${r}`);
  }
  const pool = new pg.Pool({ connectionString: opts.url, max: 2 });
  try {
    if (opts.createRoles) {
      const wanted: Array<[string, string | undefined]> = [
        [opts.appRole, opts.passwords?.app],
        [opts.retentionRole, opts.passwords?.retention],
        [opts.operatorRole, opts.passwords?.operator],
      ];
      for (const [role, password] of wanted) {
        const exists = await pool.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [role]);
        if (exists.rowCount === 0) {
          const login = password ? `LOGIN PASSWORD ${pg.escapeLiteral(password)}` : 'NOLOGIN';
          await pool.query(`CREATE ROLE "${role}" ${login}`);
        }
      }
    }
    const migrations = await migrate(pool);
    await applyGrants(pool, {
      appRole: opts.appRole,
      retentionRole: opts.retentionRole,
      operatorRole: opts.operatorRole,
    });
    return { migrations };
  } finally {
    await pool.end();
  }
}

// CLI entry point: only when executed directly, never when imported (e.g. by tests).
if (
  process.argv[1] &&
  import.meta.url === new URL(`file://${process.argv[1].replaceAll('\\', '/')}`).href
) {
  const url = process.env.MIGRATOR_DATABASE_URL;
  if (!url) {
    console.error('MIGRATOR_DATABASE_URL is not set.');
    process.exit(1);
  }
  runSetup({
    url,
    appRole: process.env.DB_APP_ROLE ?? 'scanin_app',
    retentionRole: process.env.DB_RETENTION_ROLE ?? 'scanin_retention',
    operatorRole: process.env.DB_OPERATOR_ROLE ?? 'scanin_operator',
    createRoles: process.argv.includes('--create-roles'),
    passwords: {
      ...(process.env.DB_APP_PASSWORD ? { app: process.env.DB_APP_PASSWORD } : {}),
      ...(process.env.DB_RETENTION_PASSWORD
        ? { retention: process.env.DB_RETENTION_PASSWORD }
        : {}),
      ...(process.env.DB_OPERATOR_PASSWORD ? { operator: process.env.DB_OPERATOR_PASSWORD } : {}),
    },
  })
    .then((r) =>
      console.log(
        r.migrations.length ? `Applied: ${r.migrations.join(', ')}` : 'Database is up to date.',
      ),
    )
    .catch((err: unknown) => {
      console.error('Setup failed:', (err as Error).message);
      process.exit(1);
    });
}

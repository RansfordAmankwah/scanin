import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { applyGrants, migrate } from '../../src/db/migrate.js';

/**
 * Creates a throwaway database on the server named by TEST_DATABASE_ADMIN_URL and returns a pool
 * connected to it. Real PostgreSQL is used on purpose: constraint, privilege and locking behaviour
 * cannot be trusted from mocks.
 */
export interface TestDatabase {
  pool: pg.Pool;
  name: string;
  connectionString: string;
  drop: () => Promise<void>;
}

function adminUrl(): URL {
  const raw = process.env.TEST_DATABASE_ADMIN_URL;
  if (!raw) {
    throw new Error('TEST_DATABASE_ADMIN_URL is not set (see .env.example)');
  }
  return new URL(raw);
}

export async function createTestDatabase(): Promise<TestDatabase> {
  const admin = adminUrl();
  const name = `scanin_test_${randomBytes(6).toString('hex')}`;

  const adminPool = new pg.Pool({ connectionString: admin.toString(), max: 1 });
  try {
    await adminPool.query(`CREATE DATABASE ${name}`);
  } finally {
    await adminPool.end();
  }

  const dbUrl = new URL(admin.toString());
  dbUrl.pathname = `/${name}`;
  const pool = new pg.Pool({ connectionString: dbUrl.toString() });

  const drop = async (): Promise<void> => {
    await pool.end();
    const cleanup = new pg.Pool({ connectionString: admin.toString(), max: 1 });
    try {
      await cleanup.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    } finally {
      await cleanup.end();
    }
  };

  return { pool, name, connectionString: dbUrl.toString(), drop };
}

export interface MigratedTestDatabase extends TestDatabase {
  /** Role the API connects as in production: no UPDATE/DELETE on history. */
  appRole: string;
  /** Role used only by purge jobs: SELECT and DELETE. */
  retentionRole: string;
  /** Pool whose connections run as the app role, exactly like the API in production. */
  appPool: pg.Pool;
  /** Runs `fn` on a connection acting as `role` (SET ROLE), so privilege checks are real. */
  asRole: <T>(role: string, fn: (client: pg.PoolClient) => Promise<T>) => Promise<T>;
}

/**
 * A throwaway database with all migrations applied and grants installed for freshly created,
 * uniquely named roles (roles are cluster-global, so names carry a random suffix and are dropped
 * with the database). The pool connects as the schema owner, i.e. the "migrator".
 */
export async function createMigratedTestDatabase(): Promise<MigratedTestDatabase> {
  const base = await createTestDatabase();
  const suffix = randomBytes(5).toString('hex');
  const appRole = `scanin_app_${suffix}`;
  const retentionRole = `scanin_ret_${suffix}`;

  const adminPool = new pg.Pool({ connectionString: adminUrl().toString(), max: 1 });
  try {
    for (const role of [appRole, retentionRole]) {
      await adminPool.query(`CREATE ROLE "${role}" NOLOGIN`);
      // Lets the test login switch into the role with SET ROLE.
      await adminPool.query(`GRANT "${role}" TO CURRENT_USER WITH SET TRUE`);
    }
  } finally {
    await adminPool.end();
  }

  await migrate(base.pool);
  await applyGrants(base.pool, { appRole, retentionRole });

  const asRole = async <T>(role: string, fn: (client: pg.PoolClient) => Promise<T>): Promise<T> => {
    const client = await base.pool.connect();
    try {
      await client.query(`SET ROLE "${role}"`);
      return await fn(client);
    } finally {
      await client.query('RESET ROLE').catch(() => undefined);
      client.release();
    }
  };

  // `-c role=...` makes every pooled connection act as the restricted app role.
  const appPool = new pg.Pool({
    connectionString: base.connectionString,
    options: `-c role=${appRole}`,
    max: 10,
  });

  const drop = async (): Promise<void> => {
    await appPool.end();
    await base.drop();
    const cleanup = new pg.Pool({ connectionString: adminUrl().toString(), max: 1 });
    try {
      for (const role of [appRole, retentionRole]) {
        await cleanup.query(`DROP ROLE IF EXISTS "${role}"`);
      }
    } finally {
      await cleanup.end();
    }
  };

  return { ...base, appRole, retentionRole, appPool, asRole, drop };
}

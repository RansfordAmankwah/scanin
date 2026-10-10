import { randomBytes } from 'node:crypto';
import pg from 'pg';

/**
 * Creates a throwaway database on the server named by TEST_DATABASE_ADMIN_URL and returns a pool
 * connected to it. Real PostgreSQL is used on purpose: constraint and locking behaviour cannot be
 * trusted from mocks.
 */
export interface TestDatabase {
  pool: pg.Pool;
  name: string;
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

  return { pool, name, drop };
}

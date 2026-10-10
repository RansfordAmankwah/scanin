import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from './helpers/testDb.js';

describe('real PostgreSQL test harness', () => {
  let db: TestDatabase;

  beforeAll(async () => {
    db = await createTestDatabase();
  });

  afterAll(async () => {
    await db?.drop();
  });

  it('connects to a throwaway database on a real server', async () => {
    const { rows } = await db.pool.query<{ current_database: string; v: string }>(
      'SELECT current_database(), version() AS v',
    );
    expect(rows[0]?.current_database).toBe(db.name);
    expect(rows[0]?.v).toMatch(/PostgreSQL/);
  });

  it('enforces unique constraints (proves it is a real engine, not a mock)', async () => {
    await db.pool.query('CREATE TABLE t (id int PRIMARY KEY)');
    await db.pool.query('INSERT INTO t VALUES (1)');
    await expect(db.pool.query('INSERT INTO t VALUES (1)')).rejects.toMatchObject({
      code: '23505',
    });
  });
});

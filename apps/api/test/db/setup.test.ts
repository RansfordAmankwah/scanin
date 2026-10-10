import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runSetup } from '../../src/db/setup.js';
import { createTestDatabase, type TestDatabase } from '../helpers/testDb.js';

/**
 * The deployment path: migrate + grant using a real login role with a password, then connect AS
 * that role (not via SET ROLE) and confirm the least-privilege model holds.
 */
let db: TestDatabase;
const suffix = randomBytes(4).toString('hex');
const roles = {
  app: `scanin_app_${suffix}`,
  retention: `scanin_ret_${suffix}`,
  operator: `scanin_op_${suffix}`,
};
const passwords = {
  app: `pw-${randomBytes(6).toString('hex')}`,
  retention: `pw-${randomBytes(6).toString('hex')}`,
  operator: `pw-${randomBytes(6).toString('hex')}`,
};

beforeAll(async () => {
  db = await createTestDatabase();
});

afterAll(async () => {
  await db?.drop();
  const admin = new pg.Pool({ connectionString: process.env.TEST_DATABASE_ADMIN_URL, max: 1 });
  for (const r of Object.values(roles)) await admin.query(`DROP ROLE IF EXISTS "${r}"`);
  await admin.end();
});

const connectAs = (role: string, password: string) => {
  const url = new URL(db.connectionString);
  url.username = role;
  url.password = password;
  return new pg.Pool({ connectionString: url.toString(), max: 2 });
};

describe('database setup for deployment', () => {
  it('creates login roles, migrates and grants; running it again changes nothing', async () => {
    const options = {
      url: db.connectionString,
      appRole: roles.app,
      retentionRole: roles.retention,
      operatorRole: roles.operator,
      createRoles: true,
      passwords,
    };
    const first = await runSetup(options);
    expect(first.migrations.length).toBeGreaterThanOrEqual(4);
    const second = await runSetup(options);
    expect(second.migrations).toEqual([]);
  });

  it('the application login role can do its job and nothing more', async () => {
    const app = connectAs(roles.app, passwords.app);
    try {
      // Reads and its own writes work.
      expect((await app.query('SELECT count(*)::int AS n FROM users')).rows[0].n).toBe(0);
      await app.query(
        `INSERT INTO audit_events (class, actor_type, action, retain_until) VALUES ('SECURITY','ANONYMOUS','SETUP_TEST', current_date + 1)`,
      );
      // But it cannot rewrite history, create privileged users, or change the schema.
      for (const sql of [
        `UPDATE audit_events SET action = 'x'`,
        `DELETE FROM audit_events`,
        `INSERT INTO users (role, email, full_name, password_hash) VALUES ('LECTURER', 'x@y.test', 'X', 'x')`,
        `INSERT INTO courses (term_id, code, title) VALUES (gen_random_uuid(), 'A', 'A')`,
        `DROP TABLE users`,
        `CREATE TABLE sneaky (id int)`,
      ]) {
        await expect(app.query(sql), sql).rejects.toMatchObject({ code: '42501' });
      }
    } finally {
      await app.end();
    }
  });

  it('the retention and operator login roles have exactly their own powers', async () => {
    const retention = connectAs(roles.retention, passwords.retention);
    const operator = connectAs(roles.operator, passwords.operator);
    try {
      await retention.query(`DELETE FROM audit_events WHERE action = 'SETUP_TEST'`);
      await expect(retention.query(`UPDATE users SET status = 'DISABLED'`)).rejects.toMatchObject({
        code: '42501',
      });

      await operator.query(
        `INSERT INTO terms (name, starts_on, ends_on) VALUES ('Setup test', '2026-01-01', '2026-06-01')`,
      );
      await expect(operator.query('SELECT * FROM attendance_records')).rejects.toMatchObject({
        code: '42501',
      });
    } finally {
      await retention.end();
      await operator.end();
    }
  });

  it('a login role cannot connect with the wrong password', async () => {
    const wrong = connectAs(roles.app, 'not-the-password');
    try {
      await expect(wrong.query('SELECT 1')).rejects.toMatchObject({ code: '28P01' });
    } finally {
      await wrong.end();
    }
  });

  it('refuses unsafe role names', async () => {
    await expect(
      runSetup({
        url: db.connectionString,
        appRole: 'x"; DROP TABLE users; --',
        retentionRole: roles.retention,
        operatorRole: roles.operator,
      }),
    ).rejects.toThrow(/Unsafe role name/);
  });
});

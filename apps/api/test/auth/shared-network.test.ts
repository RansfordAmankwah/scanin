import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config.js';
import {
  createTestApp,
  newRegistration,
  post,
  registerBody,
  type TestApp,
} from '../helpers/app.js';
import { createMigratedTestDatabase, type MigratedTestDatabase } from '../helpers/testDb.js';

/** A whole lecture hall on campus Wi-Fi arrives from one public address. */
let db: MigratedTestDatabase;
let hall: TestApp;
let strict: TestApp;

beforeAll(async () => {
  db = await createMigratedTestDatabase();
  hall = await createTestApp(db, { REGISTER_MAX_PER_IP_PER_HOUR: 100 });
  strict = await createTestApp(db, { REGISTER_MAX_PER_IP_PER_HOUR: 5 });
});
afterAll(async () => {
  await hall?.close();
  await strict?.close();
  await db?.drop();
});

describe('students sharing one network address', () => {
  it('can all sign up when the limit allows a class (the default is generous)', async () => {
    const campusAddress = '198.51.100.7';
    const statuses: number[] = [];
    for (let i = 0; i < 40; i++) {
      statuses.push(
        (
          await post(hall.app, '/auth/register/commit', registerBody(newRegistration()), {
            ip: campusAddress,
          })
        ).statusCode,
      );
    }
    expect(new Set(statuses)).toEqual(new Set([201]));
  });

  it('still limits sign-ups from one address when the setting is tightened', async () => {
    const address = '198.51.100.8';
    const statuses: number[] = [];
    for (let i = 0; i < 8; i++) {
      statuses.push(
        (
          await post(strict.app, '/auth/register/commit', registerBody(newRegistration()), {
            ip: address,
          })
        ).statusCode,
      );
    }
    expect(statuses).toEqual([201, 201, 201, 201, 201, 429, 429, 429]);
  });

  it('uses generous sign-up and cautious sign-in defaults, and both are settings', () => {
    const env = {
      DATABASE_URL: 'postgres://u:p@localhost/db',
      APP_ORIGIN: 'https://scanin.example.edu',
      IP_HASH_SECRET: 'x'.repeat(40),
      QR_KEYS: `k1:${'a'.repeat(43)}`,
      QR_ACTIVE_KID: 'k1',
    };
    expect(loadConfig(env)).toMatchObject({
      REGISTER_MAX_PER_IP_PER_HOUR: 100,
      LOGIN_MAX_FAILURES_PER_IP: 30,
    });
    expect(
      loadConfig({ ...env, REGISTER_MAX_PER_IP_PER_HOUR: '250', LOGIN_MAX_FAILURES_PER_IP: '60' }),
    ).toMatchObject({
      REGISTER_MAX_PER_IP_PER_HOUR: 250,
      LOGIN_MAX_FAILURES_PER_IP: 60,
    });
    expect(() => loadConfig({ ...env, REGISTER_MAX_PER_IP_PER_HOUR: '0' })).toThrow();
  });
});

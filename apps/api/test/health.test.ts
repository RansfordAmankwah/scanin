import pg from 'pg';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { MemoryMailer } from '../src/auth/mailer.js';
import { loadConfig } from '../src/config.js';
import { TEST_CONFIG } from './helpers/app.js';

describe('GET /healthz', () => {
  it('returns ok without touching the database', async () => {
    // A pool that is never connected: /healthz must not need it.
    const pool = new pg.Pool({ connectionString: 'postgres://nobody@127.0.0.1:1/none' });
    const app = await buildApp({ config: TEST_CONFIG, pool, mailer: new MemoryMailer() });
    const res = await app.inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok' });
    await app.close();
    await pool.end();
  });
});

describe('loadConfig', () => {
  const valid = {
    DATABASE_URL: 'postgres://u:p@localhost/db',
    APP_ORIGIN: 'https://app.example.test/some/path',
    IP_HASH_SECRET: 'a'.repeat(32),
    QR_KEYS: `k1:${'A'.repeat(43)}`,
    QR_ACTIVE_KID: 'k1',
  };

  it('fails fast when required variables are missing, without echoing values', () => {
    expect(() => loadConfig({ API_PORT: 'not-a-number' })).toThrowError(/Invalid configuration/);
    try {
      loadConfig({ ...valid, IP_HASH_SECRET: 'too-short-secret-value' });
    } catch (err) {
      expect(String(err)).toContain('IP_HASH_SECRET');
      expect(String(err)).not.toContain('too-short-secret-value');
    }
  });

  it('applies defaults and reduces APP_ORIGIN to an origin', () => {
    const cfg = loadConfig(valid);
    expect(cfg.API_PORT).toBe(3000);
    expect(cfg.NODE_ENV).toBe('development');
    expect(cfg.APP_ORIGIN).toBe('https://app.example.test');
    expect(cfg.ALLOW_INSECURE_COOKIES).toBe(false);
    expect(cfg.TRUST_PROXY).toBe(false);
  });

  it('refuses insecure cookies in production', () => {
    expect(() =>
      loadConfig({ ...valid, NODE_ENV: 'production', ALLOW_INSECURE_COOKIES: 'true' }),
    ).toThrowError(/ALLOW_INSECURE_COOKIES/);
  });
});

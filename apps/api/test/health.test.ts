import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';

describe('GET /healthz', () => {
  it('returns ok', async () => {
    const app = buildApp();
    const res = await app.inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok' });
    await app.close();
  });
});

describe('loadConfig', () => {
  it('fails fast when required variables are missing, without echoing values', () => {
    expect(() => loadConfig({ API_PORT: 'not-a-number' })).toThrowError(/Invalid configuration/);
    try {
      loadConfig({ API_PORT: 'secret-looking-value' });
    } catch (err) {
      expect(String(err)).not.toContain('secret-looking-value');
    }
  });

  it('applies defaults', () => {
    const cfg = loadConfig({ DATABASE_URL: 'postgres://u:p@localhost/db' });
    expect(cfg.API_PORT).toBe(3000);
    expect(cfg.NODE_ENV).toBe('development');
  });
});

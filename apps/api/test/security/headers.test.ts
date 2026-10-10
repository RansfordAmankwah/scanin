import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CSP, HSTS } from '../../src/security/headers.js';
import {
  APP_ORIGIN,
  createTestApp,
  freshIp,
  newRegistration,
  post,
  registerBody,
  type TestApp,
} from '../helpers/app.js';
import { createMigratedTestDatabase, type MigratedTestDatabase } from '../helpers/testDb.js';

let db: MigratedTestDatabase;
let plain: TestApp;
let prod: TestApp;
let withWeb: TestApp;
let dist: string;

const INDEX =
  '<!doctype html><html><head><title>ScanIn</title></head><body><div id="root"></div><script type="module" src="/assets/app-abc123.js"></script></body></html>';

beforeAll(async () => {
  db = await createMigratedTestDatabase();
  dist = await mkdtemp(join(tmpdir(), 'scanin-dist-'));
  await mkdir(join(dist, 'assets'));
  await writeFile(join(dist, 'index.html'), INDEX);
  await writeFile(join(dist, 'assets', 'app-abc123.js'), 'console.log("app")');
  await writeFile(join(dist, 'assets', 'style-def456.css'), 'body{margin:0}');
  await writeFile(
    join(dist, 'secret.txt'),
    'not for the web? it is inside dist, so it is served by name only',
  );
  plain = await createTestApp(db);
  prod = await createTestApp(db, { NODE_ENV: 'production', TRUST_PROXY: true });
  withWeb = await createTestApp(db, { WEB_DIST_DIR: dist });
});

afterAll(async () => {
  await plain?.close();
  await prod?.close();
  await withWeb?.close();
  await db?.drop();
  await rm(dist, { recursive: true, force: true });
});

describe('SEC-01 browser protections on every response', () => {
  it('sends a strict content security policy with no inline or eval allowances', async () => {
    const res = await plain.app.inject({ method: 'GET', url: '/healthz' });
    expect(res.headers['content-security-policy']).toBe(CSP);
    expect(CSP).not.toMatch(/unsafe-inline|unsafe-eval|\*/);
    expect(CSP).toContain("default-src 'self'");
    expect(CSP).toContain("frame-ancestors 'none'");
    expect(CSP).toContain("object-src 'none'");
    expect(CSP).toContain("base-uri 'none'");
    expect(CSP).toContain("img-src 'self' data: blob:"); // the QR code is a data URL
    expect(CSP).toContain("worker-src 'self' blob:"); // the camera scanner
  });

  it('sets the rest of the protective headers, allowing the camera for this origin only', async () => {
    const res = await plain.app.inject({ method: 'GET', url: '/healthz' });
    expect(res.headers).toMatchObject({
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
      'x-frame-options': 'DENY',
      'cross-origin-opener-policy': 'same-origin',
      'cross-origin-resource-policy': 'same-origin',
    });
    expect(res.headers['permissions-policy']).toBe(
      'camera=(self), microphone=(), geolocation=(), payment=(), usb=()',
    );
  });

  it('puts the headers on error responses and 404s too, and never caches API data', async () => {
    for (const res of [
      await plain.app.inject({ method: 'GET', url: '/auth/me', remoteAddress: freshIp() }), // 401
      await plain.app.inject({ method: 'GET', url: '/no/such/route' }), // 404
      await post(plain.app, '/auth/login', { nope: true }), // 400
    ]) {
      expect(res.headers['content-security-policy']).toBe(CSP);
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect(res.headers['cache-control']).toBe('no-store');
    }
  });

  it('adds HSTS only in production', async () => {
    expect(
      (await plain.app.inject({ method: 'GET', url: '/healthz' })).headers[
        'strict-transport-security'
      ],
    ).toBeUndefined();
    const res = await prod.app.inject({
      method: 'GET',
      url: '/healthz',
      headers: { 'x-forwarded-proto': 'https' },
    });
    expect(res.headers['strict-transport-security']).toBe(HSTS);
    expect(HSTS).toMatch(/max-age=31536000/);
  });

  it('redirects plain HTTP to the configured HTTPS origin in production, never to a client-chosen host', async () => {
    const res = await prod.app.inject({
      method: 'GET',
      url: '/auth/me?x=1',
      headers: { 'x-forwarded-proto': 'http', host: 'evil.example' },
    });
    expect(res.statusCode).toBe(308);
    expect(res.headers.location).toBe(`${APP_ORIGIN}/auth/me?x=1`);
    expect(res.headers.location).not.toContain('evil');

    const posted = await prod.app.inject({
      method: 'POST',
      url: '/auth/login',
      headers: { 'x-forwarded-proto': 'http' },
      payload: {},
    });
    expect(posted.statusCode).toBe(308); // method-preserving redirect

    expect(
      (
        await prod.app.inject({
          method: 'GET',
          url: '/healthz',
          headers: { 'x-forwarded-proto': 'http' },
        })
      ).statusCode,
    ).toBe(200); // platform probes
    expect(
      (
        await prod.app.inject({
          method: 'GET',
          url: '/healthz',
          headers: { 'x-forwarded-proto': 'https' },
        })
      ).statusCode,
    ).toBe(200);
    // Not behind a trusted proxy / not production: no redirect.
    expect(
      (
        await plain.app.inject({
          method: 'GET',
          url: '/healthz',
          headers: { 'x-forwarded-proto': 'http' },
        })
      ).statusCode,
    ).toBe(200);
  });

  it('does not leak the technology stack or internal errors', async () => {
    const res = await plain.app.inject({ method: 'GET', url: '/healthz' });
    expect(res.headers['x-powered-by']).toBeUndefined();
    expect(res.headers.server).toBeUndefined();
    const bad = await plain.app.inject({
      method: 'POST',
      url: '/auth/login',
      headers: {
        origin: APP_ORIGIN,
        'x-requested-with': 'scanin',
        'content-type': 'application/json',
      },
      payload: '{broken json',
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.body).not.toMatch(/at .*\.(js|ts):\d+|node_modules|SyntaxError/);
  });
});

describe('serving the web app from the same origin', () => {
  it('serves the app shell for page navigations with the protective headers', async () => {
    for (const url of [
      '/',
      '/index.html',
      '/courses/11111111-1111-4111-8111-111111111111',
      '/present/a/b',
      '/verify-email',
    ]) {
      const res = await withWeb.app.inject({
        method: 'GET',
        url,
        headers: { accept: 'text/html,application/xhtml+xml' },
      });
      expect(res.statusCode, url).toBe(200);
      expect(res.headers['content-type']).toBe('text/html; charset=utf-8');
      expect(res.body).toBe(INDEX);
      expect(res.headers['cache-control']).toBe('no-cache');
      expect(res.headers['content-security-policy']).toBe(CSP);
    }
  });

  it('serves hashed assets with long-lived caching and the right types', async () => {
    const js = await withWeb.app.inject({ method: 'GET', url: '/assets/app-abc123.js' });
    expect(js.statusCode).toBe(200);
    expect(js.headers['content-type']).toBe('text/javascript; charset=utf-8');
    expect(js.headers['cache-control']).toBe('public, max-age=31536000, immutable');
    expect(js.headers['x-content-type-options']).toBe('nosniff');
    const css = await withWeb.app.inject({ method: 'GET', url: '/assets/style-def456.css' });
    expect(css.headers['content-type']).toBe('text/css; charset=utf-8');
  });

  it('keeps API traffic separate: /api/... is the API, and a page navigation to the same path is the app', async () => {
    const id = '11111111-1111-4111-8111-111111111111';
    const api = await withWeb.app.inject({
      method: 'GET',
      url: `/api/courses/${id}`,
      headers: { accept: '*/*' },
      remoteAddress: freshIp(),
    });
    expect(api.statusCode).toBe(401);
    expect(api.json().error.code).toBe('UNAUTHENTICATED');
    // Even an API path asked for as HTML is still the API, not the app shell.
    const asHtml = await withWeb.app.inject({
      method: 'GET',
      url: `/api/courses/${id}`,
      headers: { accept: 'text/html' },
      remoteAddress: freshIp(),
    });
    expect(asHtml.statusCode).toBe(401);

    const page = await withWeb.app.inject({
      method: 'GET',
      url: `/courses/${id}`,
      headers: { accept: 'text/html' },
    });
    expect(page.statusCode).toBe(200);
    expect(page.body).toBe(INDEX);
  });

  it('runs the whole API under the /api prefix, including sign-up and sign-in', async () => {
    const reg = newRegistration();
    const headers = { origin: APP_ORIGIN, 'x-requested-with': 'scanin' };
    const made = await withWeb.app.inject({
      method: 'POST',
      url: '/api/auth/register/commit',
      headers,
      payload: registerBody(reg),
      remoteAddress: freshIp(),
    });
    expect(made.statusCode).toBe(201);
    const login = await withWeb.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers,
      payload: { email: reg.email, password: reg.password },
      remoteAddress: freshIp(),
    });
    expect(login.statusCode).toBe(200);
    expect(String(login.headers['set-cookie'])).toMatch(/^__Host-sid=/);
    const cookie = `${login.cookies[0]!.name}=${login.cookies[0]!.value}`;
    const me = await withWeb.app.inject({
      method: 'GET',
      url: '/api/auth/me',
      headers: { cookie },
    });
    expect(me.json().user.role).toBe('STUDENT');
  });

  it('can only serve files that were in the build, and never a path outside it', async () => {
    for (const url of [
      '/../package.json',
      '/assets/../../package.json',
      '/%2e%2e/%2e%2e/etc/passwd',
      '/assets/..%2f..%2fpackage.json',
      '/assets/missing.js',
    ]) {
      const res = await withWeb.app.inject({
        method: 'GET',
        url,
        headers: { accept: '*/*' },
        remoteAddress: freshIp(),
      });
      expect(res.statusCode, url).not.toBe(200);
      expect(res.body, url).not.toMatch(/"name":\s*"@scanin|root:x:0/);
    }
    // Missing script files are an error, not the HTML shell (which would be parsed as JavaScript).
    const missing = await withWeb.app.inject({
      method: 'GET',
      url: '/assets/missing.js',
      headers: { accept: '*/*' },
    });
    expect(missing.headers['content-type']).not.toMatch(/html/);
  });

  it('refuses to start with a build directory that has no app in it', async () => {
    const empty = await mkdtemp(join(tmpdir(), 'scanin-empty-'));
    try {
      await expect(createTestApp(db, { WEB_DIST_DIR: empty })).rejects.toThrow(/index\.html/);
    } finally {
      await rm(empty, { recursive: true, force: true });
    }
  });

  it('leaves the app unserved when no build directory is configured', async () => {
    const res = await plain.app.inject({
      method: 'GET',
      url: '/',
      headers: { accept: 'text/html' },
    });
    expect(res.statusCode).toBe(404);
  });
});

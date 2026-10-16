import { Writable } from 'node:stream';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { buildApp } from '../../src/app.js';
import { MemoryMailer } from '../../src/auth/mailer.js';
import { MemoryStorage } from '../../src/exports/storage.js';
import { FakeFaceVerifier, type FaceVerifier } from '../../src/face/verifier.js';
import type { Config } from '../../src/config.js';
import type { MigratedTestDatabase } from './testDb.js';

export const APP_ORIGIN = 'https://app.scanin.test';

export const TEST_CONFIG: Config = {
  DATABASE_URL: 'unused-in-tests',
  API_PORT: 3000,
  NODE_ENV: 'test',
  APP_ORIGIN,
  IP_HASH_SECRET: 'test-only-ip-hash-secret-0123456789abcdef',
  QR_KEYS: `k1:${'A'.repeat(43)},k0:${'B'.repeat(43)}`,
  QR_ACTIVE_KID: 'k1',
  QR_TOKEN_TTL_SECONDS: 15,
  FACE_VERIFIER: 'fake',
  FACE_TEMPLATE_KEY: 'C'.repeat(43),
  FACE_ENROLLMENT_SESSION_TTL_SECONDS: 300,
  FACE_NOTICE_VERSION: 'test-notice-v1',
  FACE_CHALLENGE_TTL_SECONDS: 90,
  FACE_MATCH_THRESHOLD: 0.8,
  FACE_MAX_ATTEMPTS: 5,
  FACE_DETAIL_RETENTION_DAYS: 90,
  EXPORT_TTL_MINUTES: 60,
  ALLOW_INSECURE_COOKIES: false,
  TRUST_PROXY: false,
  DEVICE_POLICY: 'BLOCK',
  // The tests exercise these limits, so they keep their strict, original values.
  REGISTER_MAX_PER_IP_PER_HOUR: 10,
  LOGIN_MAX_FAILURES_PER_IP: 30,
  HEADCOUNT_TOLERANCE_PERCENT: 15,
  HEADCOUNT_TOLERANCE_MIN: 3,
  HEADCOUNT_MAX: 2000,
  HEADCOUNT_STALE_MINUTES: 30,
  SPOT_CHECK_DEFAULT_SIZE: 5,
  SPOT_CHECK_MAX_SIZE: 20,
  SPOT_CHECK_HISTORY_SESSIONS: 2,
  SPOT_CHECK_FACE_VERIFIED_MIN: 1,
};

export interface TestApp {
  app: FastifyInstance;
  mailer: MemoryMailer;
  /** In-memory export store, so tests can inspect (and tamper with) generated files. */
  storage: MemoryStorage;
  /** The face verifier in use, so tests can assert templates were enrolled and deleted. */
  faceVerifier: FaceVerifier;
  /** Everything the API wrote to its log, for asserting that secrets never appear. */
  logs: () => string;
  close: () => Promise<void>;
}

/** The API wired to a real migrated database, connecting as the restricted app role. */
export async function createTestApp(
  db: MigratedTestDatabase,
  overrides: Partial<Config> = {},
  opts: { faceVerifier?: FaceVerifier } = {},
): Promise<TestApp> {
  const mailer = new MemoryMailer();
  const storage = new MemoryStorage();
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk, _enc, cb) {
      chunks.push(String(chunk));
      cb();
    },
  });
  const faceVerifier = opts.faceVerifier ?? new FakeFaceVerifier();
  const app = await buildApp({
    config: { ...TEST_CONFIG, ...overrides },
    pool: db.appPool,
    mailer,
    exportStorage: storage,
    faceVerifier,
    logger: { level: 'trace', stream },
  });
  await app.ready();
  return {
    app,
    mailer,
    storage,
    faceVerifier,
    logs: () => chunks.join(''),
    close: () => app.close(),
  };
}

let ipCounter = 0;
/** A unique client IP per call, so tests do not share per-IP rate-limit buckets by accident. */
export function freshIp(): string {
  ipCounter += 1;
  return `10.${(ipCounter >> 16) & 255}.${(ipCounter >> 8) & 255}.${ipCounter & 255}`;
}

export interface PostOptions {
  cookie?: string;
  ip?: string;
  headers?: Record<string, string>;
  /** Omit the CSRF headers to simulate a cross-site request. */
  noCsrf?: boolean;
}

export function post(app: FastifyInstance, url: string, payload: unknown, opts: PostOptions = {}) {
  const headers: Record<string, string> = { ...opts.headers };
  if (!opts.noCsrf) {
    headers.origin = APP_ORIGIN;
    headers['x-requested-with'] = 'scanin';
  }
  if (opts.cookie) headers.cookie = opts.cookie;
  const req: InjectOptions = {
    method: 'POST',
    url,
    payload: payload as object,
    headers,
    remoteAddress: opts.ip ?? freshIp(),
  };
  return app.inject(req);
}

export function get(app: FastifyInstance, url: string, opts: { cookie?: string } = {}) {
  return app.inject({
    method: 'GET',
    url,
    headers: opts.cookie ? { cookie: opts.cookie } : {},
    remoteAddress: freshIp(),
  });
}

export interface Registration {
  studentId: string;
  fullName: string;
  email: string;
  password: string;
}

let userCounter = 0;
export function newRegistration(overrides: Partial<Registration> = {}): Registration {
  userCounter += 1;
  return {
    studentId: `ST${String(userCounter).padStart(6, '0')}`,
    fullName: 'Ama Mensah',
    email: `student${userCounter}@school.test`,
    password: 'correct-horse-battery-7',
    ...overrides,
  };
}

export const registerBody = (r: Registration) => ({ ...r, confirmed: true });

/** Registers and logs in; returns the session cookie header value. */
export async function registerAndLogin(
  app: FastifyInstance,
  reg: Registration = newRegistration(),
): Promise<{ cookie: string; reg: Registration }> {
  const created = await post(app, '/auth/register/commit', registerBody(reg));
  if (created.statusCode !== 201) throw new Error(`register failed: ${created.statusCode}`);
  const login = await post(app, '/auth/login', { email: reg.email, password: reg.password });
  if (login.statusCode !== 200) throw new Error(`login failed: ${login.statusCode}`);
  return { cookie: cookieHeader(login), reg };
}

export function cookieHeader(res: { cookies: Array<{ name: string; value: string }> }): string {
  const c = res.cookies[0];
  if (!c) throw new Error('response set no cookie');
  return `${c.name}=${c.value}`;
}

/** Operator-provisions a lecturer and signs them in; returns their id and session cookie. */
export async function createLecturerSession(
  db: MigratedTestDatabase,
  app: FastifyInstance,
  email: string,
  fullName = 'Dr Test',
): Promise<{ id: string; cookie: string }> {
  const { createLecturer } = await import('../../src/operator/commands.js');
  const lecturer = await createLecturer(db.operatorPool, { operator: 'test', email, fullName });
  const res = await post(app, '/auth/login', { email, password: lecturer.temporaryPassword });
  if (res.statusCode !== 200) throw new Error(`lecturer login failed: ${res.statusCode}`);
  return { id: lecturer.id, cookie: cookieHeader(res) };
}

/** Registers a student (optionally verifying their e-mail) and returns the new user id. */
export async function registerStudent(
  db: MigratedTestDatabase,
  t: Pick<TestApp, 'app' | 'mailer'>,
  reg: Registration,
  opts: { verifyEmail?: boolean } = {},
): Promise<string> {
  const res = await post(t.app, '/auth/register/commit', registerBody(reg));
  if (res.statusCode !== 201) throw new Error(`register failed: ${res.statusCode}`);
  if (opts.verifyEmail) {
    const link = t.mailer.outbox.filter((m) => m.to === reg.email.toLowerCase()).at(-1)?.link ?? '';
    const token = new URL(link).hash.replace('#t=', '');
    const verified = await post(t.app, '/auth/verify-email', { token });
    if (verified.statusCode !== 200) throw new Error('verification failed');
  }
  const { rows } = await db.pool.query<{ id: string }>('SELECT id FROM users WHERE email = $1', [
    reg.email.toLowerCase(),
  ]);
  return rows[0]?.id as string;
}

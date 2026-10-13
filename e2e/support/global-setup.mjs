import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:net';
import { mkdirSync, mkdtempSync, writeFileSync, createWriteStream } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import pg from 'pg';

/**
 * Starts the PRODUCTION build (compiled API serving the built web app) against a throwaway
 * database, exactly the way it would run when deployed: separate least-privilege database roles
 * with passwords, migrations applied by the setup tool, the operator CLI functions provisioning a
 * lecturer and a course. Nothing here uses test-only shortcuts in the application.
 *
 * Requires `pnpm build` first.
 */
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const api = join(root, 'apps', 'api', 'dist');

function loadEnvFile() {
  try {
    process.loadEnvFile(join(root, '.env'));
  } catch {
    // CI provides the variables directly.
  }
}

function freePort() {
  return new Promise((resolvePort, reject) => {
    const srv = createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolvePort(port));
    });
  });
}

const import_ = (file) => import(pathToFileURL(join(api, file)).href);

export default async function globalSetup() {
  loadEnvFile();
  const adminUrl = process.env.TEST_DATABASE_ADMIN_URL;
  if (!adminUrl) throw new Error('TEST_DATABASE_ADMIN_URL is not set (see .env.example)');

  const suffix = randomBytes(4).toString('hex');
  const dbName = `scanin_e2e_${suffix}`;
  const roles = {
    app: `e2e_app_${suffix}`,
    retention: `e2e_ret_${suffix}`,
    operator: `e2e_op_${suffix}`,
  };
  const pw = () => randomBytes(9).toString('hex');
  const passwords = { app: pw(), retention: pw(), operator: pw() };

  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${dbName}`);
  await admin.end();

  const asUrl = (user, password, db = dbName) => {
    const u = new URL(adminUrl);
    u.pathname = `/${db}`;
    if (user) {
      u.username = user;
      u.password = password;
    }
    return u.toString();
  };
  const migratorUrl = asUrl(null, null);

  const { runSetup } = await import_('db/setup.js');
  await runSetup({
    url: migratorUrl,
    appRole: roles.app,
    retentionRole: roles.retention,
    operatorRole: roles.operator,
    createRoles: true,
    passwords,
  });

  // Provision a lecturer and a course the way the operator would.
  const { createPool } = await import_('db/pool.js');
  const ops = await import_('operator/commands.js');
  const opPool = createPool(asUrl(roles.operator, passwords.operator));
  const lecturerEmail = 'lecturer@e2e.test';
  await ops.createTerm(opPool, {
    operator: 'e2e',
    name: 'E2E term',
    startsOn: '2026-09-01',
    endsOn: '2027-06-30',
  });
  const course = await ops.createCourse(opPool, {
    operator: 'e2e',
    term: 'E2E term',
    code: 'E2E101',
    title: 'End to End Testing',
  });
  const lecturer = await ops.createLecturer(opPool, {
    operator: 'e2e',
    email: lecturerEmail,
    fullName: 'Dr Eve Lecturer',
  });
  await ops.assignLecturer(opPool, {
    operator: 'e2e',
    term: 'E2E term',
    courseCode: 'E2E101',
    lecturerEmail,
  });
  await opPool.end();

  const port = await freePort();
  const origin = `http://localhost:${port}`;
  const exportDir = mkdtempSync(join(tmpdir(), 'scanin-e2e-exports-'));
  mkdirSync(join(root, 'e2e', 'test-results'), { recursive: true });
  const logPath = join(root, 'e2e', 'test-results', 'server.log');
  const log = createWriteStream(logPath);

  const server = spawn(process.execPath, [join(api, 'server.js')], {
    cwd: root,
    env: {
      ...process.env,
      NODE_ENV: 'development', // allows the console mailer, which prints verification links to the log
      DATABASE_URL: asUrl(roles.app, passwords.app),
      API_PORT: String(port),
      APP_ORIGIN: origin,
      IP_HASH_SECRET: randomBytes(32).toString('base64url'),
      QR_KEYS: `k1:${randomBytes(32).toString('base64url')}`,
      QR_ACTIVE_KID: 'k1',
      WEB_DIST_DIR: join(root, 'apps', 'web', 'dist'),
      EXPORT_DIR: exportDir,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.pipe(log);
  server.stderr.pipe(log);

  // Wait until it answers.
  const deadline = Date.now() + 90_000; // generous: a cold start on a busy laptop can be slow
  for (;;) {
    try {
      const res = await fetch(`${origin}/healthz`);
      if (res.ok) break;
    } catch {
      // not up yet
    }
    if (server.exitCode !== null) throw new Error(`Server exited early (see ${logPath})`);
    if (Date.now() > deadline) throw new Error(`Server did not start (see ${logPath})`);
    await new Promise((r) => setTimeout(r, 250));
  }

  const state = {
    origin,
    port,
    dbName,
    adminUrl,
    roles,
    pid: server.pid,
    logPath,
    exportDir,
    courseId: course.id,
    lecturer: { email: lecturerEmail, password: lecturer.temporaryPassword, id: lecturer.id },
  };
  const statePath = join(tmpdir(), `scanin-e2e-state-${suffix}.json`);
  writeFileSync(statePath, JSON.stringify(state));
  process.env.SCANIN_E2E_STATE = statePath;
  process.env.SCANIN_E2E_ORIGIN = origin;
}

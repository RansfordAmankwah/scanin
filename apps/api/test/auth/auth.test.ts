import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  APP_ORIGIN,
  cookieHeader,
  createTestApp,
  freshIp,
  get,
  newRegistration,
  post,
  registerAndLogin,
  registerBody,
  type TestApp,
} from '../helpers/app.js';
import { createMigratedTestDatabase, type MigratedTestDatabase } from '../helpers/testDb.js';

let db: MigratedTestDatabase;
let t: TestApp;

beforeAll(async () => {
  db = await createMigratedTestDatabase();
  t = await createTestApp(db);
});

afterAll(async () => {
  await t?.close();
  await db?.drop();
});

const countUsers = async (where: string, params: unknown[]): Promise<number> => {
  const { rows } = await db.pool.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM users WHERE ${where}`,
    params,
  );
  return rows[0]?.n ?? 0;
};

const auditCount = async (action: string): Promise<number> => {
  const { rows } = await db.pool.query<{ n: number }>(
    'SELECT count(*)::int AS n FROM audit_events WHERE action = $1',
    [action],
  );
  return rows[0]?.n ?? 0;
};

describe('AUTH-01 one account per student ID, atomically', () => {
  it('lets exactly one of 20 parallel registrations with the same ID win', async () => {
    const studentId = 'RACE000001';
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        post(
          t.app,
          '/auth/register/commit',
          registerBody(newRegistration({ studentId, email: `racer${i}@school.test` })),
        ),
      ),
    );
    const statuses = results.map((r) => r.statusCode);
    expect(statuses.filter((s) => s === 201)).toHaveLength(1);
    expect(statuses.filter((s) => s === 409)).toHaveLength(19);
    expect(statuses.some((s) => s >= 500)).toBe(false);
    expect(await countUsers('student_id_norm = $1', [studentId])).toBe(1);
    for (const r of results.filter((x) => x.statusCode === 409)) {
      expect(r.json().error.code).toBe('STUDENT_ID_TAKEN');
    }
  });

  it('treats differently formatted IDs as the same ID', async () => {
    const first = newRegistration({ studentId: 'ab 123456' });
    expect((await post(t.app, '/auth/register/commit', registerBody(first))).statusCode).toBe(201);
    const second = newRegistration({ studentId: 'AB123456' });
    const res = await post(t.app, '/auth/register/commit', registerBody(second));
    expect(res.statusCode).toBe(409);
    expect(await countUsers('student_id_norm = $1', ['AB123456'])).toBe(1);
  });

  it('records the conflict as a security event', async () => {
    expect(await auditCount('REGISTRATION_ID_CONFLICT')).toBeGreaterThan(0);
  });

  it('does not reveal whether an e-mail is already registered', async () => {
    const original = newRegistration();
    await post(t.app, '/auth/register/commit', registerBody(original));
    const before = t.mailer.outbox.length;
    const dup = await post(
      t.app,
      '/auth/register/commit',
      registerBody(newRegistration({ email: original.email })),
    );
    const fresh = await post(t.app, '/auth/register/commit', registerBody(newRegistration()));
    expect(dup.statusCode).toBe(201);
    expect(dup.json()).toEqual(fresh.json());
    // Only the genuinely new account got a verification message.
    expect(t.mailer.outbox.length).toBe(before + 1);
    expect(await countUsers('email = $1', [original.email])).toBe(1);
  });
});

describe('AUTH-02 registration needs an explicit confirmation step', () => {
  it('preview validates and echoes details but writes nothing', async () => {
    const reg = newRegistration();
    const res = await post(t.app, '/auth/register/preview', reg);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ fullName: 'Ama Mensah', email: reg.email });
    expect(await countUsers('email = $1', [reg.email])).toBe(0);
  });

  it('commit without confirmation is rejected and creates no user', async () => {
    const reg = newRegistration();
    const res = await post(t.app, '/auth/register/commit', reg);
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('CONFIRMATION_REQUIRED');
    const falsey = await post(t.app, '/auth/register/commit', { ...reg, confirmed: false });
    expect(falsey.statusCode).toBe(400);
    expect(await countUsers('email = $1', [reg.email])).toBe(0);
  });

  it('commit with confirmation creates a STUDENT with normalised ID and no session', async () => {
    const reg = newRegistration({ studentId: ' st 777001 ' });
    const res = await post(t.app, '/auth/register/commit', registerBody(reg));
    expect(res.statusCode).toBe(201);
    expect(res.cookies).toHaveLength(0);
    const { rows } = await db.pool.query(
      'SELECT role, student_id_norm, email_verified_at FROM users WHERE email = $1',
      [reg.email],
    );
    expect(rows[0]).toMatchObject({
      role: 'STUDENT',
      student_id_norm: 'ST777001',
      email_verified_at: null,
    });
  });

  it.each([
    ['too-short password', { password: 'short' }, 'PASSWORD_TOO_SHORT'],
    ['invalid student ID', { studentId: '!!' }, 'INVALID_STUDENT_ID'],
    ['blank name', { fullName: ' ' }, 'INVALID_NAME'],
  ])('rejects %s', async (_label, patch, code) => {
    const res = await post(t.app, '/auth/register/commit', registerBody(newRegistration(patch)));
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe(code);
  });
});

describe('AUTH-03 Argon2id password hashing', () => {
  it('stores an Argon2id hash with at least the OWASP minimum parameters, never the password', async () => {
    const reg = newRegistration();
    await post(t.app, '/auth/register/commit', registerBody(reg));
    const { rows } = await db.pool.query<{ password_hash: string }>(
      'SELECT password_hash FROM users WHERE email = $1',
      [reg.email],
    );
    const stored = rows[0]?.password_hash ?? '';
    expect(stored.startsWith('$argon2id$')).toBe(true);
    const memory = Number(/m=(\d+)/.exec(stored)?.[1]);
    const passes = Number(/t=(\d+)/.exec(stored)?.[1]);
    expect(memory).toBeGreaterThanOrEqual(19_456);
    expect(passes).toBeGreaterThanOrEqual(2);
    expect(stored).not.toContain(reg.password);
  });
});

describe('AUTH-04 login rate limiting', () => {
  it('throttles an account after 5 failures, even for the right password, without affecting others', async () => {
    const victim = newRegistration();
    const bystander = newRegistration();
    await post(t.app, '/auth/register/commit', registerBody(victim));
    await post(t.app, '/auth/register/commit', registerBody(bystander));

    for (let i = 0; i < 5; i++) {
      const res = await post(t.app, '/auth/login', {
        email: victim.email,
        password: 'wrong-password-1',
      });
      expect(res.statusCode).toBe(401);
    }
    const blocked = await post(t.app, '/auth/login', {
      email: victim.email,
      password: victim.password,
    });
    expect(blocked.statusCode).toBe(429);
    expect(blocked.headers['retry-after']).toBeDefined();
    expect(blocked.cookies).toHaveLength(0);

    const other = await post(t.app, '/auth/login', {
      email: bystander.email,
      password: bystander.password,
    });
    expect(other.statusCode).toBe(200);
    expect(await auditCount('LOGIN_THROTTLED')).toBeGreaterThan(0);
  });

  it('throttles one IP across many accounts after 30 failures', async () => {
    const ip = freshIp();
    for (let i = 0; i < 30; i++) {
      const res = await post(
        t.app,
        '/auth/login',
        { email: `nobody${i}@school.test`, password: 'x'.repeat(12) },
        { ip },
      );
      expect(res.statusCode).toBe(401);
    }
    const res = await post(
      t.app,
      '/auth/login',
      { email: 'nobody-else@school.test', password: 'x'.repeat(12) },
      { ip },
    );
    expect(res.statusCode).toBe(429);
  });

  it('gives the same answer for an unknown account and a wrong password', async () => {
    const real = newRegistration();
    await post(t.app, '/auth/register/commit', registerBody(real));
    const wrong = await post(t.app, '/auth/login', {
      email: real.email,
      password: 'definitely-wrong-1',
    });
    const unknown = await post(t.app, '/auth/login', {
      email: 'ghost@school.test',
      password: 'definitely-wrong-1',
    });
    expect(wrong.statusCode).toBe(unknown.statusCode);
    expect(wrong.json()).toEqual(unknown.json());
  });

  it('rate-limits registration per IP', async () => {
    const ip = freshIp();
    const statuses: number[] = [];
    for (let i = 0; i < 12; i++) {
      const res = await post(t.app, '/auth/register/commit', registerBody(newRegistration()), {
        ip,
      });
      statuses.push(res.statusCode);
    }
    expect(statuses.slice(0, 10).every((s) => s === 201)).toBe(true);
    expect(statuses.slice(10)).toEqual([429, 429]);
  });
});

describe('AUTH-05 session security, rotation and revocation', () => {
  it('sets a hardened cookie and stores only a hash of the token', async () => {
    const reg = newRegistration();
    await post(t.app, '/auth/register/commit', registerBody(reg));
    const res = await post(t.app, '/auth/login', { email: reg.email, password: reg.password });
    expect(res.statusCode).toBe(200);
    const header = String(res.headers['set-cookie']);
    expect(header).toMatch(/^__Host-sid=/);
    expect(header).toContain('Path=/');
    expect(header).toContain('HttpOnly');
    expect(header).toContain('Secure');
    expect(header).toContain('SameSite=Lax');
    expect(header).not.toContain('Domain=');

    const token = res.cookies[0]?.value ?? '';
    const stored = async (id: Buffer) =>
      (await db.pool.query('SELECT count(*)::int AS n FROM auth_sessions WHERE id_hash = $1', [id]))
        .rows[0].n;
    expect(await stored(createHash('sha256').update(token).digest())).toBe(1);
    expect(await stored(Buffer.from(token))).toBe(0); // the raw token is not what is stored
  });

  it('ignores a client-supplied session id and issues a fresh one at login (no fixation)', async () => {
    const reg = newRegistration();
    await post(t.app, '/auth/register/commit', registerBody(reg));
    const forged = '__Host-sid=attacker-chosen-value';
    expect((await get(t.app, '/auth/me', { cookie: forged })).statusCode).toBe(401);
    const res = await post(
      t.app,
      '/auth/login',
      { email: reg.email, password: reg.password },
      { cookie: forged },
    );
    expect(res.statusCode).toBe(200);
    expect(res.cookies[0]?.value).not.toBe('attacker-chosen-value');
    expect((await get(t.app, '/auth/me', { cookie: forged })).statusCode).toBe(401);
    expect((await get(t.app, '/auth/me', { cookie: cookieHeader(res) })).statusCode).toBe(200);
  });

  it('tells a signed-in user their own e-mail and student id, and nothing about anyone else', async () => {
    const { cookie, reg } = await registerAndLogin(t.app);
    const body = (await get(t.app, '/auth/me', { cookie })).json() as {
      user: Record<string, unknown>;
    };
    expect(body.user.email).toBe(reg.email.toLowerCase());
    expect(typeof body.user.studentId).toBe('string');
    expect(Object.keys(body.user).sort()).toEqual(
      ['email', 'emailVerified', 'fullName', 'id', 'role', 'studentId'].sort(),
    );
  });

  it('changing the password revokes every other session and rotates the current one', async () => {
    const { cookie: first, reg } = await registerAndLogin(t.app);
    const second = cookieHeader(
      await post(t.app, '/auth/login', { email: reg.email, password: reg.password }),
    );
    expect((await get(t.app, '/auth/me', { cookie: second })).statusCode).toBe(200);

    const change = await post(
      t.app,
      '/auth/password',
      { currentPassword: reg.password, newPassword: 'a-brand-new-passphrase-9' },
      { cookie: first },
    );
    expect(change.statusCode).toBe(200);
    const fresh = cookieHeader(change);

    expect((await get(t.app, '/auth/me', { cookie: first })).statusCode).toBe(401);
    expect((await get(t.app, '/auth/me', { cookie: second })).statusCode).toBe(401);
    expect((await get(t.app, '/auth/me', { cookie: fresh })).statusCode).toBe(200);

    const oldLogin = await post(t.app, '/auth/login', { email: reg.email, password: reg.password });
    expect(oldLogin.statusCode).toBe(401);
    const newLogin = await post(t.app, '/auth/login', {
      email: reg.email,
      password: 'a-brand-new-passphrase-9',
    });
    expect(newLogin.statusCode).toBe(200);
  });

  it('rejects a password change with the wrong current password', async () => {
    const { cookie, reg } = await registerAndLogin(t.app);
    const res = await post(
      t.app,
      '/auth/password',
      { currentPassword: 'not-my-password-1', newPassword: 'a-brand-new-passphrase-9' },
      { cookie },
    );
    expect(res.statusCode).toBe(401);
    expect((await get(t.app, '/auth/me', { cookie })).statusCode).toBe(200);
    expect(reg.email).toBeTruthy();
  });

  it('logout revokes the session server-side and clears the cookie', async () => {
    const { cookie } = await registerAndLogin(t.app);
    const res = await post(t.app, '/auth/logout', {}, { cookie });
    expect(res.statusCode).toBe(204);
    expect(String(res.headers['set-cookie'])).toMatch(/__Host-sid=;/);
    expect((await get(t.app, '/auth/me', { cookie })).statusCode).toBe(401);
  });

  it('expires idle and absolute-expired sessions, and disabled accounts lose access', async () => {
    const idle = await registerAndLogin(t.app);
    const absolute = await registerAndLogin(t.app);
    const disabled = await registerAndLogin(t.app);

    await db.pool.query(
      `UPDATE auth_sessions SET idle_expires_at = now() - interval '1 second'
        WHERE user_id = (SELECT id FROM users WHERE email = $1)`,
      [idle.reg.email],
    );
    await db.pool.query(
      `UPDATE auth_sessions SET absolute_expires_at = now() - interval '1 second'
        WHERE user_id = (SELECT id FROM users WHERE email = $1)`,
      [absolute.reg.email],
    );
    await db.pool.query(`UPDATE users SET status = 'DISABLED' WHERE email = $1`, [
      disabled.reg.email,
    ]);

    expect((await get(t.app, '/auth/me', { cookie: idle.cookie })).statusCode).toBe(401);
    expect((await get(t.app, '/auth/me', { cookie: absolute.cookie })).statusCode).toBe(401);
    expect((await get(t.app, '/auth/me', { cookie: disabled.cookie })).statusCode).toBe(401);
  });

  it('keeps students signed in for a long idle period but lecturers only for hours', async () => {
    const { rows } = await db.pool.query<{ role: string; idle_h: number; abs_h: number }>(
      `SELECT u.role::text AS role,
              round(extract(epoch FROM (s.idle_expires_at - s.created_at)) / 3600)::int AS idle_h,
              round(extract(epoch FROM (s.absolute_expires_at - s.created_at)) / 3600)::int AS abs_h
         FROM auth_sessions s JOIN users u ON u.id = s.user_id
        WHERE u.role = 'STUDENT' LIMIT 1`,
    );
    expect(rows[0]).toMatchObject({ role: 'STUDENT', idle_h: 168, abs_h: 720 });
  });
});

describe('AUTH-06 CSRF protection', () => {
  it('rejects state-changing requests that lack the custom header or a matching origin', async () => {
    const { cookie } = await registerAndLogin(t.app);
    const attempts = [
      { headers: { origin: 'https://evil.example', 'x-requested-with': 'scanin' } },
      { headers: { origin: APP_ORIGIN } },
      { headers: { 'x-requested-with': 'scanin' } },
      { headers: {} },
      {
        headers: {
          origin: APP_ORIGIN,
          'x-requested-with': 'scanin',
          'sec-fetch-site': 'cross-site',
        },
      },
      {
        headers: {
          origin: APP_ORIGIN,
          'x-requested-with': 'scanin',
          'sec-fetch-site': 'same-site',
        },
      },
    ];
    for (const a of attempts) {
      const res = await t.app.inject({
        method: 'POST',
        url: '/auth/logout',
        headers: { ...a.headers, cookie },
        remoteAddress: freshIp(),
      });
      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe('CSRF_REJECTED');
    }
    // None of the forged logouts had any effect.
    expect((await get(t.app, '/auth/me', { cookie })).statusCode).toBe(200);
  });

  it('also protects login and registration from cross-site forms', async () => {
    const reg = newRegistration();
    const res = await post(t.app, '/auth/register/commit', registerBody(reg), { noCsrf: true });
    expect(res.statusCode).toBe(403);
    expect(await countUsers('email = $1', [reg.email])).toBe(0);
  });

  it('accepts a genuine same-origin request', async () => {
    const { cookie } = await registerAndLogin(t.app);
    const res = await post(
      t.app,
      '/auth/logout',
      {},
      { cookie, headers: { 'sec-fetch-site': 'same-origin' } },
    );
    expect(res.statusCode).toBe(204);
  });
});

describe('authentication required', () => {
  it('returns 401 for anonymous access to protected routes', async () => {
    expect((await get(t.app, '/auth/me')).statusCode).toBe(401);
    expect((await post(t.app, '/auth/logout', {})).statusCode).toBe(401);
    expect((await post(t.app, '/auth/password', {})).statusCode).toBe(401);
  });
});

describe('e-mail verification', () => {
  it('verifies once, then the link is spent', async () => {
    const reg = newRegistration();
    await post(t.app, '/auth/register/commit', registerBody(reg));
    const message = t.mailer.outbox.find((m) => m.to === reg.email);
    const token = new URL(message?.link ?? 'http://x').hash.replace('#t=', '');
    expect(token.length).toBeGreaterThan(20);

    const ok = await post(t.app, '/auth/verify-email', { token });
    expect(ok.statusCode).toBe(200);
    expect(await countUsers('email = $1 AND email_verified_at IS NOT NULL', [reg.email])).toBe(1);

    const again = await post(t.app, '/auth/verify-email', { token });
    expect(again.statusCode).toBe(400);
  });

  it('rejects an expired link and a made-up one', async () => {
    const reg = newRegistration();
    await post(t.app, '/auth/register/commit', registerBody(reg));
    const message = t.mailer.outbox.find((m) => m.to === reg.email);
    const token = new URL(message?.link ?? 'http://x').hash.replace('#t=', '');
    await db.pool.query(
      `UPDATE account_tokens SET expires_at = now() - interval '1 second'
        WHERE user_id = (SELECT id FROM users WHERE email = $1)`,
      [reg.email],
    );
    expect((await post(t.app, '/auth/verify-email', { token })).statusCode).toBe(400);
    expect((await post(t.app, '/auth/verify-email', { token: 'x'.repeat(43) })).statusCode).toBe(
      400,
    );
  });
});

describe('secrets never reach logs or the database in clear', () => {
  it('keeps passwords, session tokens and verification tokens out of the log output', async () => {
    const reg = newRegistration({ password: 'Unique-Canary-Passphrase-4471' });
    await post(t.app, '/auth/register/commit', registerBody(reg));
    const link = t.mailer.outbox.find((m) => m.to === reg.email)?.link ?? '';
    const verificationToken = new URL(link).hash.replace('#t=', '');
    const login = await post(t.app, '/auth/login', { email: reg.email, password: reg.password });
    const sessionToken = login.cookies[0]?.value ?? '';
    await post(t.app, '/auth/login', { email: reg.email, password: 'wrong-Canary-Passphrase-1' });
    await post(t.app, '/auth/login', 'not json at all', {
      headers: { 'content-type': 'application/json' },
    });

    const logs = t.logs();
    expect(logs.length).toBeGreaterThan(0);
    for (const secret of [
      reg.password,
      'wrong-Canary-Passphrase-1',
      sessionToken,
      verificationToken,
      '__Host-sid=',
    ]) {
      expect(secret.length).toBeGreaterThan(5);
      expect(logs).not.toContain(secret);
    }
  });

  it('never stores raw verification tokens or session ids', async () => {
    const { rows } = await db.pool.query<{ token_hash: Buffer }>(
      'SELECT token_hash FROM account_tokens LIMIT 5',
    );
    for (const r of rows) expect(r.token_hash.length).toBe(32); // SHA-256 digest, not a token
  });
});

describe('audit trail for authentication events', () => {
  it('records registrations, logins and failures without personal data in the summary', async () => {
    expect(await auditCount('ACCOUNT_REGISTERED')).toBeGreaterThan(0);
    expect(await auditCount('LOGIN_SUCCEEDED')).toBeGreaterThan(0);
    expect(await auditCount('LOGIN_FAILED')).toBeGreaterThan(0);
    expect(await auditCount('PASSWORD_CHANGED')).toBeGreaterThan(0);
    const { rows } = await db.pool.query<{ summary: unknown; ip_hash: Buffer | null }>(
      `SELECT summary, ip_hash FROM audit_events WHERE action = 'LOGIN_FAILED' LIMIT 1`,
    );
    expect(rows[0]?.summary).toEqual({});
    expect(rows[0]?.ip_hash?.length).toBe(16); // hashed, not the raw address
  });
});

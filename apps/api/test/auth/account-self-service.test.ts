import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runRetention } from '../../src/retention/service.js';
import {
  createLecturerSession,
  createTestApp,
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

const tokenFromLink = (link: string) => new URL(link).hash.replace('#t=', '');

const lastLink = (kind: 'reset' | 'change' | 'verify', to: string): string =>
  t.mailer.outbox.filter((m) => m.kind === kind && m.to === to.toLowerCase()).at(-1)?.link ?? '';

const userRow = async (email: string) =>
  (
    await db.pool.query<{
      id: string;
      status: string;
      email: string;
      email_verified_at: Date | null;
      deletion_requested_at: Date | null;
    }>(
      `SELECT id, status, email::text AS email, email_verified_at, deletion_requested_at
         FROM users WHERE email = $1`,
      [email.toLowerCase()],
    )
  ).rows[0];

describe('forgot/reset password', () => {
  it('sends a reset link, lets it set a new password, and revokes the old one', async () => {
    const reg = newRegistration();
    await post(t.app, '/auth/register/commit', registerBody(reg));

    const req = await post(t.app, '/auth/password/forgot', { email: reg.email });
    expect(req.statusCode).toBe(200);
    expect(req.json().status).toBe('reset_requested');

    const token = tokenFromLink(lastLink('reset', reg.email));
    expect(token).not.toBe('');

    const reset = await post(t.app, '/auth/password/reset', {
      token,
      newPassword: 'a-brand-new-passphrase-9',
    });
    expect(reset.statusCode).toBe(200);

    // Old password no longer works; new one does.
    const oldLogin = await post(t.app, '/auth/login', { email: reg.email, password: reg.password });
    expect(oldLogin.statusCode).toBe(401);
    const newLogin = await post(t.app, '/auth/login', {
      email: reg.email,
      password: 'a-brand-new-passphrase-9',
    });
    expect(newLogin.statusCode).toBe(200);
  });

  it('rejects a reused reset token', async () => {
    const reg = newRegistration();
    await post(t.app, '/auth/register/commit', registerBody(reg));
    await post(t.app, '/auth/password/forgot', { email: reg.email });
    const token = tokenFromLink(lastLink('reset', reg.email));

    const first = await post(t.app, '/auth/password/reset', {
      token,
      newPassword: 'first-change-77a',
    });
    expect(first.statusCode).toBe(200);
    const second = await post(t.app, '/auth/password/reset', {
      token,
      newPassword: 'second-change-88b',
    });
    expect(second.statusCode).toBe(400);
    expect(second.json().error.code).toBe('INVALID_OR_EXPIRED_LINK');
  });

  it('rejects an expired reset token', async () => {
    const reg = newRegistration();
    await post(t.app, '/auth/register/commit', registerBody(reg));
    await post(t.app, '/auth/password/forgot', { email: reg.email });
    const token = tokenFromLink(lastLink('reset', reg.email));
    // Age the token past its expiry (owner pool; the app role cannot touch expires_at).
    await db.pool.query(
      `UPDATE account_tokens SET expires_at = clock_timestamp() - interval '1 hour'
        WHERE purpose = 'PASSWORD_RESET' AND used_at IS NULL`,
    );
    const reset = await post(t.app, '/auth/password/reset', {
      token,
      newPassword: 'too-late-change-9',
    });
    expect(reset.statusCode).toBe(400);
  });

  it('does not reveal whether an address exists', async () => {
    const before = t.mailer.outbox.length;
    const res = await post(t.app, '/auth/password/forgot', { email: 'nobody@nowhere.test' });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('reset_requested');
    expect(t.mailer.outbox.length).toBe(before); // nothing sent
  });

  it('enforces the password policy on reset', async () => {
    const reg = newRegistration();
    await post(t.app, '/auth/register/commit', registerBody(reg));
    await post(t.app, '/auth/password/forgot', { email: reg.email });
    const token = tokenFromLink(lastLink('reset', reg.email));
    const reset = await post(t.app, '/auth/password/reset', { token, newPassword: 'short' });
    expect(reset.statusCode).toBe(400);
    expect(reset.json().error.code).toBe('PASSWORD_TOO_SHORT');
  });
});

describe('change e-mail', () => {
  it('changes the address, marks it unverified, and re-verifies from the link', async () => {
    const { cookie, reg } = await registerAndLogin(t.app);
    const newEmail = `moved${Date.now()}@school.test`;
    const res = await post(
      t.app,
      '/auth/email/change',
      { newEmail, currentPassword: reg.password },
      { cookie },
    );
    expect(res.statusCode).toBe(200);

    const row = await userRow(newEmail);
    expect(row?.email).toBe(newEmail);
    expect(row?.email_verified_at).toBeNull();

    const token = tokenFromLink(lastLink('change', newEmail));
    expect(token).not.toBe('');
    const verified = await post(t.app, '/auth/verify-email', { token });
    expect(verified.statusCode).toBe(200);
    expect((await userRow(newEmail))?.email_verified_at).not.toBeNull();
  });

  it('requires the correct current password', async () => {
    const { cookie } = await registerAndLogin(t.app);
    const res = await post(
      t.app,
      '/auth/email/change',
      { newEmail: 'nope@school.test', currentPassword: 'wrong-password-xx' },
      { cookie },
    );
    expect(res.statusCode).toBe(401);
  });

  it('refuses an address already in use', async () => {
    const taken = await registerAndLogin(t.app);
    const { cookie, reg } = await registerAndLogin(t.app);
    const res = await post(
      t.app,
      '/auth/email/change',
      { newEmail: taken.reg.email, currentPassword: reg.password },
      { cookie },
    );
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('EMAIL_TAKEN');
  });
});

describe('delete account', () => {
  it('requires the correct password', async () => {
    const { cookie } = await registerAndLogin(t.app);
    const res = await post(t.app, '/auth/account/delete', { password: 'wrong' }, { cookie });
    expect(res.statusCode).toBe(401);
  });

  it('flags the account, disables it, and revokes the session', async () => {
    const { cookie, reg } = await registerAndLogin(t.app);
    const res = await post(t.app, '/auth/account/delete', { password: reg.password }, { cookie });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('deletion_requested');

    const row = await userRow(reg.email);
    expect(row?.status).toBe('DISABLED');
    expect(row?.deletion_requested_at).not.toBeNull();

    // The session is gone: a protected route no longer recognises the cookie.
    const me = await t.app.inject({ method: 'GET', url: '/auth/me', headers: { cookie } });
    expect(me.statusCode).toBe(401);
  });

  it('does not let a lecturer self-delete', async () => {
    const { cookie } = await createLecturerSession(db, t.app, `lec${Date.now()}@school.test`);
    const res = await post(t.app, '/auth/account/delete', { password: 'whatever' }, { cookie });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('LECTURER_DELETE_UNSUPPORTED');
  });
});

describe('retention erases deletion-requested accounts', () => {
  it('erases a flagged student account and its data after the grace period', async () => {
    const { cookie, reg } = await registerAndLogin(t.app);
    const id = (await userRow(reg.email))!.id;
    // A referencing row in a cascade branch, to prove the erase reaches beyond the users table.
    await db.pool.query(
      `INSERT INTO biometric_consent_events (student_id, event_no, kind, notice_version)
       VALUES ($1, 1, 'GRANTED', 'test-notice-v1')`,
      [id],
    );
    await post(t.app, '/auth/account/delete', { password: reg.password }, { cookie });
    // Age the request past the grace window.
    await db.pool.query(
      `UPDATE users SET deletion_requested_at = clock_timestamp() - interval '30 days' WHERE id = $1`,
      [id],
    );

    const report = await runRetention(db.retentionPool);
    expect(report.accountsDeleted).toBeGreaterThanOrEqual(1);

    const gone = await db.pool.query('SELECT 1 FROM users WHERE id = $1', [id]);
    expect(gone.rowCount).toBe(0);
    const consent = await db.pool.query(
      'SELECT 1 FROM biometric_consent_events WHERE student_id = $1',
      [id],
    );
    expect(consent.rowCount).toBe(0);
  });
});

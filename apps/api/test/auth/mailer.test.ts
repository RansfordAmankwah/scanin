import { describe, expect, it } from 'vitest';
import { ResendMailer } from '../../src/auth/mailer.js';
import { loadConfig } from '../../src/config.js';

const BASE_ENV = {
  DATABASE_URL: 'postgres://u:p@localhost/db',
  APP_ORIGIN: 'https://scanin.example.edu',
  IP_HASH_SECRET: 'x'.repeat(40),
  QR_KEYS: `k1:${'a'.repeat(43)}`,
  QR_ACTIVE_KID: 'k1',
};

describe('ResendMailer', () => {
  it('posts one authenticated message to the recipient, with the link in the text', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fake = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response('{"id":"1"}', { status: 200 });
    }) as unknown as typeof fetch;
    const mailer = new ResendMailer('re_key', 'ScanIn <no-reply@example.edu>', fake);

    await mailer.sendEmailVerification('s@school.edu', 'https://x/verify-email#t=abc');

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://api.resend.com/emails');
    expect((calls[0]!.init.headers as Record<string, string>).Authorization).toBe('Bearer re_key');
    const body = JSON.parse(calls[0]!.init.body as string);
    expect(body.to).toEqual(['s@school.edu']);
    expect(body.from).toBe('ScanIn <no-reply@example.edu>');
    expect(body.text).toContain('https://x/verify-email#t=abc');
  });

  it('fails without leaking the key, the link or the response body when Resend refuses', async () => {
    const fake = (async () =>
      new Response('secret-detail', { status: 403 })) as unknown as typeof fetch;
    const mailer = new ResendMailer('re_key', 'a@b.c', fake);
    const err = await mailer
      .sendEmailVerification('s@school.edu', 'https://x/verify-email#t=abc')
      .catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    const message = (err as Error).message;
    expect(message).toContain('403');
    for (const secret of ['re_key', 'abc', 'secret-detail']) expect(message).not.toContain(secret);
  });
});

describe('mail configuration', () => {
  it('is required in production', () => {
    expect(() => loadConfig({ ...BASE_ENV, NODE_ENV: 'production' })).toThrow(/RESEND_API_KEY/);
    expect(() =>
      loadConfig({ ...BASE_ENV, NODE_ENV: 'production', RESEND_API_KEY: 're_key' }),
    ).toThrow(/RESEND_API_KEY|MAIL_FROM/);
    expect(
      loadConfig({
        ...BASE_ENV,
        NODE_ENV: 'production',
        RESEND_API_KEY: 're_key',
        MAIL_FROM: 'ScanIn <no-reply@example.edu>',
      }).MAIL_FROM,
    ).toBeDefined();
  });

  it('is optional in development, but a key without a sender is refused', () => {
    expect(() => loadConfig({ ...BASE_ENV, NODE_ENV: 'development' })).not.toThrow();
    expect(() =>
      loadConfig({ ...BASE_ENV, NODE_ENV: 'development', RESEND_API_KEY: 're_key' }),
    ).toThrow(/MAIL_FROM/);
  });
});

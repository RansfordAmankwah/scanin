import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  assignLecturer,
  createCourse,
  createLecturer,
  createTerm,
} from '../../src/operator/commands.js';
import type { PaymentProvider } from '../../src/billing/paystack.js';
import { cookieHeader, createTestApp, post, type TestApp } from '../helpers/app.js';
import { createMigratedTestDatabase, type MigratedTestDatabase } from '../helpers/testDb.js';

class FakeProvider implements PaymentProvider {
  readonly initialized: Array<{ reference: string; amountMinor: number }> = [];
  async initialize(input: { reference: string; amountMinor: number }) {
    this.initialized.push({ reference: input.reference, amountMinor: input.amountMinor });
    return { authorizationUrl: `https://pay.test/${input.reference}` };
  }
  verifySignature(_raw: Buffer, sig: string | undefined) {
    return sig === 'valid';
  }
}

let db: MigratedTestDatabase;
let t: TestApp; // billing enabled
let provider: FakeProvider;
let seq = 0;

beforeAll(async () => {
  db = await createMigratedTestDatabase();
  provider = new FakeProvider();
  t = await createTestApp(
    db,
    { PAYSTACK_SECRET_KEY: 'sk_test_fake' },
    { paymentProvider: provider },
  );
  await createTerm(db.operatorPool, {
    operator: 'bill',
    name: 'BT',
    startsOn: '2026-09-01',
    endsOn: '2026-12-20',
  });
});

afterAll(async () => {
  await t?.close();
  await db?.drop();
});

/** A freshly provisioned, e-mail-verified lecturer (so inside the trial), signed in. */
async function lecturer(): Promise<{ id: string; cookie: string; email: string }> {
  seq += 1;
  const email = `bill${seq}@school.test`;
  const made = await createLecturer(db.operatorPool, {
    operator: 'bill',
    email,
    fullName: 'Dr Bill',
  });
  const login = await post(t.app, '/auth/login', { email, password: made.temporaryPassword });
  return { id: made.id, cookie: cookieHeader(login), email };
}

async function courseWithSession(lecturerEmail: string, cookie: string) {
  seq += 1;
  const code = `BC${seq}`;
  const { id: courseId } = await createCourse(db.operatorPool, {
    operator: 'bill',
    term: 'BT',
    code,
    title: code,
  });
  await assignLecturer(db.operatorPool, {
    operator: 'bill',
    term: 'BT',
    courseCode: code,
    lecturerEmail,
  });
  const sessionId = (
    await post(t.app, `/courses/${courseId}/sessions`, { title: 'Lecture' }, { cookie })
  ).json().session.id as string;
  return { courseId, sessionId };
}

const statusOf = async (cookie: string) =>
  (await t.app.inject({ method: 'GET', url: '/billing/status', headers: { cookie } })).json();

// The trial runs from the first session, so an expired trial is a trial_started_at well in the past.
const expireTrial = (id: string) =>
  db.pool.query(
    `UPDATE users SET trial_started_at = clock_timestamp() - interval '60 days' WHERE id = $1`,
    [id],
  );

const webhook = (sig: string | undefined, body: unknown) =>
  t.app.inject({
    method: 'POST',
    url: '/billing/webhook',
    headers: {
      'content-type': 'application/json',
      ...(sig ? { 'x-paystack-signature': sig } : {}),
    },
    payload: body as object,
  });

const chargeSuccess = (lecturerId: string, reference: string, amount = 2500) => ({
  event: 'charge.success',
  data: { reference, amount, currency: 'GHS', metadata: { lecturerId } },
});

describe('billing gate on running a session', () => {
  it('starts the trial on the first session and lets it run', async () => {
    const l = await lecturer();
    // Verified but no session yet: the trial has not started.
    expect((await statusOf(l.cookie)).reason).toBe('TRIAL_NOT_STARTED');
    const { courseId, sessionId } = await courseWithSession(l.email, l.cookie);
    const res = await post(
      t.app,
      `/courses/${courseId}/sessions/${sessionId}/start`,
      {},
      { cookie: l.cookie },
    );
    expect(res.statusCode).toBe(200);
    // Running that first session began the trial clock.
    expect((await statusOf(l.cookie)).reason).toBe('TRIAL');
  });

  it('blocks a lecturer whose trial has lapsed, with 402', async () => {
    const l = await lecturer();
    const { courseId, sessionId } = await courseWithSession(l.email, l.cookie);
    await expireTrial(l.id);
    expect((await statusOf(l.cookie)).reason).toBe('EXPIRED');
    const res = await post(
      t.app,
      `/courses/${courseId}/sessions/${sessionId}/start`,
      {},
      { cookie: l.cookie },
    );
    expect(res.statusCode).toBe(402);
    expect(res.json().error.code).toBe('SUBSCRIPTION_REQUIRED');
  });

  it('a paid webhook extends the period and unblocks the lecturer', async () => {
    const l = await lecturer();
    const { courseId, sessionId } = await courseWithSession(l.email, l.cookie);
    await expireTrial(l.id);

    const paid = await webhook('valid', chargeSuccess(l.id, `ref_${seq}_a`));
    expect(paid.statusCode).toBe(200);

    const status = await statusOf(l.cookie);
    expect(status.reason).toBe('SUBSCRIBED');
    const res = await post(
      t.app,
      `/courses/${courseId}/sessions/${sessionId}/start`,
      {},
      { cookie: l.cookie },
    );
    expect(res.statusCode).toBe(200);
  });

  it('an exempt lecturer always has access', async () => {
    const l = await lecturer();
    await expireTrial(l.id);
    await db.pool.query('UPDATE users SET billing_exempt = true WHERE id = $1', [l.id]);
    expect((await statusOf(l.cookie)).reason).toBe('EXEMPT');
  });
});

describe('billing webhook', () => {
  it('rejects an unsigned or wrongly signed request', async () => {
    const l = await lecturer();
    expect((await webhook(undefined, chargeSuccess(l.id, 'ref_x'))).statusCode).toBe(401);
    expect((await webhook('wrong', chargeSuccess(l.id, 'ref_y'))).statusCode).toBe(401);
  });

  it('applies a payment exactly once for a repeated reference', async () => {
    const l = await lecturer();
    const ref = `ref_${seq}_dup`;
    await webhook('valid', chargeSuccess(l.id, ref));
    await webhook('valid', chargeSuccess(l.id, ref)); // duplicate delivery
    const n = (
      await db.pool.query<{ n: number }>(
        'SELECT count(*)::int AS n FROM subscription_payments WHERE lecturer_id = $1',
        [l.id],
      )
    ).rows[0]!.n;
    expect(n).toBe(1);
  });
});

describe('checkout', () => {
  it('starts a Paystack checkout and returns the authorization URL', async () => {
    const l = await lecturer();
    const res = await post(t.app, '/billing/checkout', {}, { cookie: l.cookie });
    expect(res.statusCode).toBe(200);
    expect(res.json().authorizationUrl).toMatch(/^https:\/\/pay\.test\//);
    expect(provider.initialized.at(-1)?.amountMinor).toBe(2500);
  });
});

describe('billing disabled (no provider)', () => {
  let plain: TestApp;
  beforeAll(async () => {
    plain = await createTestApp(db); // default: no PAYSTACK_SECRET_KEY
  });
  afterAll(async () => {
    await plain?.close();
  });

  it('gates nobody and reports BILLING_DISABLED', async () => {
    seq += 1;
    const email = `plain${seq}@school.test`;
    const made = await createLecturer(db.operatorPool, {
      operator: 'bill',
      email,
      fullName: 'Dr Plain',
    });
    const login = await post(plain.app, '/auth/login', { email, password: made.temporaryPassword });
    const cookie = cookieHeader(login);
    const status = (
      await plain.app.inject({ method: 'GET', url: '/billing/status', headers: { cookie } })
    ).json();
    expect(status).toMatchObject({ access: true, reason: 'BILLING_DISABLED' });
  });
});

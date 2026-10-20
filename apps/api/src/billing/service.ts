import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { writeAudit } from '../audit.js';
import type { Config } from '../config.js';
import { withTransaction } from '../db/pool.js';
import type { PaymentProvider } from './paystack.js';

export type BillingReason =
  | 'BILLING_DISABLED' // no payment provider configured; nobody is gated
  | 'EXEMPT' // comped account
  | 'TRIAL' // inside the free trial
  | 'TRIAL_NOT_STARTED' // verified, never run a session: the trial begins on the first one
  | 'SUBSCRIBED' // an unexpired paid period (incl. grace)
  | 'EMAIL_UNVERIFIED' // cannot start the trial until the e-mail is verified
  | 'EXPIRED'; // trial and any subscription have lapsed

export interface BillingStatus {
  access: boolean;
  reason: BillingReason;
  exempt: boolean;
  emailVerified: boolean;
  /** When the free trial ends (null if the e-mail is not verified yet). */
  trialEndsAt: string | null;
  /** End of the current paid period, if any. */
  currentPeriodEnd: string | null;
  /** Access is retained until this instant (trial end, or period end + grace). */
  accessUntil: string | null;
  priceMinor: number;
  currency: string;
}

export const billingEnabled = (config: Config): boolean => Boolean(config.PAYSTACK_SECRET_KEY);

/** Stamps the trial start the first time a lecturer runs a session. Idempotent (only when null). */
export async function startTrialIfNeeded(
  db: Pick<pg.Pool, 'query'>,
  lecturerId: string,
): Promise<void> {
  await db.query(
    `UPDATE users SET trial_started_at = clock_timestamp()
      WHERE id = $1 AND role = 'LECTURER' AND trial_started_at IS NULL`,
    [lecturerId],
  );
}

interface LecturerRow {
  email_verified_at: Date | null;
  billing_exempt: boolean;
  trial_started_at: Date | null;
  current_period_end: Date | null;
}

async function loadLecturer(
  db: Pick<pg.Pool, 'query'>,
  lecturerId: string,
): Promise<LecturerRow | null> {
  const { rows } = await db.query<LecturerRow>(
    `SELECT u.email_verified_at, u.billing_exempt, u.trial_started_at, s.current_period_end
       FROM users u
       LEFT JOIN subscriptions s ON s.lecturer_id = u.id
      WHERE u.id = $1 AND u.role = 'LECTURER'`,
    [lecturerId],
  );
  return rows[0] ?? null;
}

/** The lecturer's current access state. Pure read; used both by the status route and the gate. */
export async function billingStatus(
  db: Pick<pg.Pool, 'query'>,
  config: Config,
  lecturerId: string,
): Promise<BillingStatus> {
  const u = await loadLecturer(db, lecturerId);
  const base = {
    exempt: u?.billing_exempt ?? false,
    emailVerified: u?.email_verified_at != null,
    trialEndsAt: null as string | null,
    currentPeriodEnd: u?.current_period_end?.toISOString() ?? null,
    accessUntil: null as string | null,
    priceMinor: config.SUBSCRIPTION_PRICE_MINOR,
    currency: config.SUBSCRIPTION_CURRENCY,
  };

  if (!billingEnabled(config)) return { ...base, access: true, reason: 'BILLING_DISABLED' };
  if (!u) return { ...base, access: false, reason: 'EXPIRED' };
  if (u.billing_exempt) return { ...base, access: true, reason: 'EXEMPT' };

  const now = Date.now();
  // The trial clock runs from the first session a lecturer starts, not from e-mail verification.
  const trialEnd = u.trial_started_at
    ? u.trial_started_at.getTime() + config.BILLING_TRIAL_DAYS * 86_400_000
    : null;
  const periodAccessEnd = u.current_period_end
    ? u.current_period_end.getTime() + config.BILLING_GRACE_DAYS * 86_400_000
    : null;

  const trialEndsAt = trialEnd ? new Date(trialEnd).toISOString() : null;

  if (trialEnd && now < trialEnd) {
    return { ...base, access: true, reason: 'TRIAL', trialEndsAt, accessUntil: trialEndsAt };
  }
  if (periodAccessEnd && now < periodAccessEnd) {
    return {
      ...base,
      access: true,
      reason: 'SUBSCRIBED',
      trialEndsAt,
      accessUntil: new Date(periodAccessEnd).toISOString(),
    };
  }
  if (!u.email_verified_at) {
    return { ...base, access: false, reason: 'EMAIL_UNVERIFIED', trialEndsAt };
  }
  // Verified, never run a session: the trial has not started. Access is granted so the first session
  // start can begin it (the session-start path stamps trial_started_at).
  if (!u.trial_started_at) {
    return { ...base, access: true, reason: 'TRIAL_NOT_STARTED' };
  }
  return { ...base, access: false, reason: 'EXPIRED', trialEndsAt };
}

/** A Paystack reference that encodes the lecturer, so a webhook can be tied back without a lookup table. */
export const newReference = (lecturerId: string): string =>
  `scanin_${lecturerId.replace(/-/g, '')}_${Date.now()}_${randomUUID().slice(0, 8)}`;

/** Starts a hosted checkout for one subscription period and returns where to send the lecturer. */
export async function startCheckout(
  pool: pg.Pool,
  config: Config,
  provider: PaymentProvider,
  input: { lecturerId: string; email: string },
): Promise<{ authorizationUrl: string; reference: string }> {
  const reference = newReference(input.lecturerId);
  const { authorizationUrl } = await provider.initialize({
    email: input.email,
    amountMinor: config.SUBSCRIPTION_PRICE_MINOR,
    currency: config.SUBSCRIPTION_CURRENCY,
    reference,
    callbackUrl: `${config.APP_ORIGIN}/account/billing`,
    metadata: { lecturerId: input.lecturerId, purpose: 'scanin_subscription' },
  });
  return { authorizationUrl, reference };
}

/**
 * Records a settled payment and extends the subscription period. Idempotent on the Paystack
 * reference: a webhook delivered twice adds exactly one period. A new period starts from the later
 * of now and the current period end, so paying early never loses days.
 */
export async function applyPayment(
  pool: pg.Pool,
  config: Config,
  input: {
    lecturerId: string;
    reference: string;
    amountMinor: number;
    currency: string;
    requestId?: string;
  },
): Promise<{ applied: boolean; currentPeriodEnd: string | null }> {
  return withTransaction(pool, async (c) => {
    const inserted = await c.query<{ id: string }>(
      `INSERT INTO subscription_payments
         (lecturer_id, paystack_reference, amount_minor, currency, period_start, period_end)
       VALUES ($1, $2, $3, $4,
               GREATEST(clock_timestamp(), COALESCE((SELECT current_period_end FROM subscriptions WHERE lecturer_id = $1), clock_timestamp())),
               GREATEST(clock_timestamp(), COALESCE((SELECT current_period_end FROM subscriptions WHERE lecturer_id = $1), clock_timestamp()))
                 + make_interval(days => $5))
       ON CONFLICT (paystack_reference) DO NOTHING
       RETURNING id`,
      [
        input.lecturerId,
        input.reference,
        input.amountMinor,
        input.currency,
        config.SUBSCRIPTION_PERIOD_DAYS,
      ],
    );
    if (inserted.rowCount === 0) {
      const existing = await c.query<{ current_period_end: Date | null }>(
        'SELECT current_period_end FROM subscriptions WHERE lecturer_id = $1',
        [input.lecturerId],
      );
      return {
        applied: false,
        currentPeriodEnd: existing.rows[0]?.current_period_end?.toISOString() ?? null,
      };
    }
    const period = await c.query<{ period_end: Date }>(
      'SELECT period_end FROM subscription_payments WHERE paystack_reference = $1',
      [input.reference],
    );
    const periodEnd = period.rows[0]!.period_end;
    await c.query(
      `INSERT INTO subscriptions (lecturer_id, current_period_end)
       VALUES ($1, $2)
       ON CONFLICT (lecturer_id)
       DO UPDATE SET current_period_end = EXCLUDED.current_period_end, updated_at = clock_timestamp()`,
      [input.lecturerId, periodEnd],
    );
    // A payment is a financial record: keep its audit event well beyond the usual domain window.
    const retainUntil = new Date(Date.now() + 7 * 365 * 86_400_000).toISOString().slice(0, 10);
    await writeAudit(c, {
      class: 'DOMAIN',
      actorType: 'SYSTEM',
      actorUserId: input.lecturerId,
      action: 'SUBSCRIPTION_PAYMENT',
      entityType: 'subscription',
      entityId: input.lecturerId,
      retainUntil,
      ...(input.requestId ? { requestId: input.requestId } : {}),
      summary: {
        amountMinor: input.amountMinor,
        currency: input.currency,
        periodEnd: periodEnd.toISOString(),
      },
    });
    return { applied: true, currentPeriodEnd: periodEnd.toISOString() };
  });
}

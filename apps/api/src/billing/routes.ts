import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { LECTURER_ONLY } from '../authz/index.js';
import type { Config } from '../config.js';
import type { PaymentProvider } from './paystack.js';
import { applyPayment, billingEnabled, billingStatus, startCheckout } from './service.js';

declare module 'fastify' {
  interface FastifyRequest {
    /** Raw request body, preserved by the JSON parser so the webhook signature can be checked. */
    rawBody?: Buffer;
  }
}

const LECTURER = { config: { authz: { roles: LECTURER_ONLY } } };
const PUBLIC = { config: { authz: { public: true as const } } };

export interface BillingDeps {
  pool: pg.Pool;
  config: Config;
  /** Null when no payment provider is configured (billing off). */
  provider: PaymentProvider | null;
}

interface ChargeEvent {
  event?: string;
  data?: {
    reference?: string;
    amount?: number;
    currency?: string;
    metadata?: { lecturerId?: string };
  };
}

export function registerBillingRoutes(app: FastifyInstance, deps: BillingDeps): void {
  const { pool, config, provider } = deps;

  /** The signed-in lecturer's own billing state (trial, subscription, or exemption). */
  app.get('/billing/status', LECTURER, async (req) =>
    billingStatus(pool, config, req.auth?.userId as string),
  );

  /** Starts a hosted Paystack checkout for one period and returns where to send the lecturer. */
  app.post('/billing/checkout', LECTURER, async (req, reply) => {
    if (!provider || !billingEnabled(config)) {
      return reply
        .code(503)
        .send({ error: { code: 'BILLING_NOT_CONFIGURED', message: 'Billing is not available.' } });
    }
    const lecturerId = req.auth?.userId as string;
    const { rows } = await pool.query<{ email: string }>(
      `SELECT email::text AS email FROM users WHERE id = $1`,
      [lecturerId],
    );
    const email = rows[0]?.email;
    if (!email)
      return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Not found.' } });
    try {
      const { authorizationUrl } = await startCheckout(pool, config, provider, {
        lecturerId,
        email,
      });
      return { authorizationUrl };
    } catch (err) {
      req.log.error({ err: (err as Error).name }, 'checkout init failed');
      return reply.code(502).send({
        error: { code: 'CHECKOUT_FAILED', message: 'Could not start payment. Try again.' },
      });
    }
  });

  /**
   * Paystack delivers settled payments here. Signed with our secret key (HMAC-SHA512 of the raw
   * body); an unsigned or wrongly signed request is rejected. A valid charge.success for one of our
   * subscription payments extends the lecturer's period. The handler is idempotent and always
   * answers 200 for anything it has handled or does not care about, so Paystack stops retrying.
   */
  app.post('/billing/webhook', PUBLIC, async (req, reply) => {
    if (!provider) return reply.code(503).send({ received: false });
    const sig = req.headers['x-paystack-signature'] as string | undefined;
    if (!req.rawBody || !provider.verifySignature(req.rawBody, sig)) {
      return reply
        .code(401)
        .send({ error: { code: 'INVALID_SIGNATURE', message: 'Invalid signature.' } });
    }
    const event = req.body as ChargeEvent;
    const d = event.data;
    if (event.event === 'charge.success' && d?.reference && d.metadata?.lecturerId) {
      const lecturerId = d.metadata.lecturerId;
      const okCurrency = d.currency === config.SUBSCRIPTION_CURRENCY;
      const okAmount = typeof d.amount === 'number' && d.amount >= config.SUBSCRIPTION_PRICE_MINOR;
      if (okCurrency && okAmount) {
        const exists = await pool.query(`SELECT 1 FROM users WHERE id = $1 AND role = 'LECTURER'`, [
          lecturerId,
        ]);
        if (exists.rowCount) {
          await applyPayment(pool, config, {
            lecturerId,
            reference: d.reference,
            amountMinor: d.amount as number,
            currency: d.currency as string,
            requestId: req.id,
          });
        }
      }
    }
    return reply.code(200).send({ received: true });
  });
}

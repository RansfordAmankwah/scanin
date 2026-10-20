import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * The slice of Paystack we use: start a hosted checkout, and verify the webhook signature. It is an
 * interface so tests inject a fake and inspect what would be charged, exactly like the mailer.
 */
export interface PaymentProvider {
  /** Starts a hosted payment and returns the URL to send the lecturer to. */
  initialize(input: {
    email: string;
    amountMinor: number;
    currency: string;
    reference: string;
    callbackUrl: string;
    metadata: Record<string, unknown>;
  }): Promise<{ authorizationUrl: string }>;
  /** True when a webhook body was signed with our secret key. */
  verifySignature(rawBody: Buffer, signature: string | undefined): boolean;
}

/** Talks to Paystack over HTTPS (no SDK). Amounts are in the currency's minor unit. */
export class PaystackProvider implements PaymentProvider {
  constructor(
    private readonly secretKey: string,
    private readonly fetchFn: typeof fetch = fetch,
  ) {}

  async initialize(input: {
    email: string;
    amountMinor: number;
    currency: string;
    reference: string;
    callbackUrl: string;
    metadata: Record<string, unknown>;
  }): Promise<{ authorizationUrl: string }> {
    const res = await this.fetchFn('https://api.paystack.co/transaction/initialize', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.secretKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        email: input.email,
        amount: input.amountMinor,
        currency: input.currency,
        reference: input.reference,
        callback_url: input.callbackUrl,
        metadata: input.metadata,
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`Paystack rejected the request (HTTP ${res.status})`);
    const body = (await res.json()) as { data?: { authorization_url?: string } };
    const url = body.data?.authorization_url;
    if (!url) throw new Error('Paystack returned no authorization URL');
    return { authorizationUrl: url };
  }

  verifySignature(rawBody: Buffer, signature: string | undefined): boolean {
    if (!signature) return false;
    const expected = createHmac('sha512', this.secretKey).update(rawBody).digest('hex');
    const a = Buffer.from(expected, 'utf8');
    const b = Buffer.from(signature, 'utf8');
    return a.length === b.length && timingSafeEqual(a, b);
  }
}

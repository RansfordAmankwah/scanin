export interface Mailer {
  /** `link` carries a single-use token in its URL fragment. Implementations must not log it. */
  sendEmailVerification(to: string, link: string): Promise<void>;
}

/** Collects messages in memory. Used by tests. */
export class MemoryMailer implements Mailer {
  readonly outbox: Array<{ to: string; link: string }> = [];

  async sendEmailVerification(to: string, link: string): Promise<void> {
    this.outbox.push({ to, link });
  }
}

/** Sends through Resend's HTTPS API (no SDK). The link is never logged, and errors carry no body. */
export class ResendMailer implements Mailer {
  constructor(
    private readonly apiKey: string,
    private readonly from: string,
    private readonly fetchFn: typeof fetch = fetch,
  ) {}

  async sendEmailVerification(to: string, link: string): Promise<void> {
    const res = await this.fetchFn('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: this.from,
        to: [to],
        subject: 'Verify your ScanIn e-mail',
        text: `Open this link to verify your e-mail address for ScanIn:

${link}

If you did not create a ScanIn account, ignore this message.`,
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`Resend rejected the message (HTTP ${res.status})`);
  }
}

/**
 * Prints the link to the console so a developer can click it. Refuses to run in production, where
 * a real mail provider is required (an open decision) and tokens must never reach logs.
 */
export class DevConsoleMailer implements Mailer {
  constructor(nodeEnv: string) {
    if (nodeEnv === 'production') {
      throw new Error('DevConsoleMailer cannot be used in production');
    }
  }

  async sendEmailVerification(to: string, link: string): Promise<void> {
    console.log(`[dev mailer] verification for ${to}: ${link}`);
  }
}

export interface Mailer {
  /** `link` carries a single-use token in its URL fragment. Implementations must not log it. */
  sendEmailVerification(to: string, link: string): Promise<void>;
  /** Password-reset link. Carries a single-use token in its fragment; never log it. */
  sendPasswordReset(to: string, link: string): Promise<void>;
  /** Verifies a newly chosen e-mail address. Sent to the new address; never log the link. */
  sendEmailChangeVerification(to: string, link: string): Promise<void>;
}

/** Collects messages in memory. Used by tests. */
export class MemoryMailer implements Mailer {
  readonly outbox: Array<{ kind: 'verify' | 'reset' | 'change'; to: string; link: string }> = [];

  async sendEmailVerification(to: string, link: string): Promise<void> {
    this.outbox.push({ kind: 'verify', to, link });
  }

  async sendPasswordReset(to: string, link: string): Promise<void> {
    this.outbox.push({ kind: 'reset', to, link });
  }

  async sendEmailChangeVerification(to: string, link: string): Promise<void> {
    this.outbox.push({ kind: 'change', to, link });
  }
}

/** Sends through Resend's HTTPS API (no SDK). The link is never logged, and errors carry no body. */
export class ResendMailer implements Mailer {
  constructor(
    private readonly apiKey: string,
    private readonly from: string,
    private readonly fetchFn: typeof fetch = fetch,
  ) {}

  private async send(to: string, subject: string, text: string): Promise<void> {
    const res = await this.fetchFn('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ from: this.from, to: [to], subject, text }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`Resend rejected the message (HTTP ${res.status})`);
  }

  async sendEmailVerification(to: string, link: string): Promise<void> {
    await this.send(
      to,
      'Verify your ScanIn e-mail',
      `Open this link to verify your e-mail address for ScanIn:

${link}

If you did not create a ScanIn account, ignore this message.`,
    );
  }

  async sendPasswordReset(to: string, link: string): Promise<void> {
    await this.send(
      to,
      'Reset your ScanIn password',
      `Open this link to choose a new password for ScanIn:

${link}

This link can be used once and expires soon. If you did not ask to reset your password, ignore this message; your password stays unchanged.`,
    );
  }

  async sendEmailChangeVerification(to: string, link: string): Promise<void> {
    await this.send(
      to,
      'Confirm your new ScanIn e-mail',
      `You asked to change the e-mail address on your ScanIn account to this one. Open this link to confirm it:

${link}

If you did not ask for this, ignore this message.`,
    );
  }
}

/**
 * Prints the link to the console so a developer can click it. Refuses to run in production, where
 * a real mail provider is required and tokens must never reach logs.
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

  async sendPasswordReset(to: string, link: string): Promise<void> {
    console.log(`[dev mailer] password reset for ${to}: ${link}`);
  }

  async sendEmailChangeVerification(to: string, link: string): Promise<void> {
    console.log(`[dev mailer] e-mail change for ${to}: ${link}`);
  }
}

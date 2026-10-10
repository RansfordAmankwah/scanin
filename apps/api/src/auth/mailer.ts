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

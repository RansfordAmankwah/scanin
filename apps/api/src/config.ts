import { z } from 'zod';

const booleanString = z
  .enum(['true', 'false'])
  .default('false')
  .transform((v) => v === 'true');

const ConfigSchema = z
  .object({
    DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
    API_PORT: z.coerce.number().int().min(1).max(65535).default(3000),
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    /** Exact origin of the web app (scheme + host + port). Used for CSRF checks and e-mail links. */
    APP_ORIGIN: z
      .string()
      .url()
      .transform((v) => new URL(v).origin),
    /** Secret used to HMAC IP addresses before storage or rate limiting. At least 32 characters. */
    IP_HASH_SECRET: z.string().min(32, 'IP_HASH_SECRET must be at least 32 characters'),
    /**
     * QR signing keys as "kid:base64url-key,kid2:base64url-key" (each at least 32 random bytes).
     * Rotation: add a new key and make it active; keep the old one listed for at least 4 minutes
     * so codes already on screen keep verifying, then remove it.
     */
    QR_KEYS: z.string().min(1, 'QR_KEYS is required'),
    /** Id of the key used to sign new codes. Must be one of QR_KEYS. */
    QR_ACTIVE_KID: z.string().min(1, 'QR_ACTIVE_KID is required'),
    /**
     * How long a QR code stays usable, in seconds. Short on purpose: a code relayed outside the room
     * is useful for seconds, not minutes. The projector refreshes this often, and check-in also
     * accepts the immediately previous window, so the real acceptance window is up to twice this.
     */
    QR_TOKEN_TTL_SECONDS: z.coerce.number().int().min(5).max(120).default(15),
    /** Private directory for generated export files (pilot). Defaults to a temp folder. */
    EXPORT_DIR: z.string().min(1).optional(),
    /** How long a generated export stays downloadable. Provisional: 60 minutes. */
    EXPORT_TTL_MINUTES: z.coerce.number().int().min(1).max(1440).default(60),
    /** Connection string for the retention database role (read + delete only). Jobs are off without it. */
    RETENTION_DATABASE_URL: z.string().min(1).optional(),
    /** Location for audit checkpoints; must be owned by someone independent of the database owner. Off if unset. */
    AUDIT_CHECKPOINT_DIR: z.string().min(1).optional(),
    /** Directory of the built web app (apps/web/dist). When set, the API serves it from the same origin. */
    WEB_DIST_DIR: z.string().min(1).optional(),
    /** Resend API key. Required in production; without it, development prints links to the console. */
    RESEND_API_KEY: z.string().min(1).optional(),
    /** Sender for system e-mail, on a domain verified in Resend, e.g. "ScanIn <no-reply@example.edu>". */
    MAIL_FROM: z.string().min(3).optional(),
    /** Development convenience only: allows the session cookie over plain HTTP. */
    ALLOW_INSECURE_COOKIES: booleanString,
    /**
     * What happens when one device checks in a second student for the same class: BLOCK rejects it,
     * FLAG records it and raises a flag for the lecturer to review.
     */
    DEVICE_POLICY: z.enum(['BLOCK', 'FLAG']).default('BLOCK'),
    /**
     * Headcount reconciliation. Recorded attendance is flagged for REVIEW (never rejected) when it
     * exceeds the lecturer's headcount by more than max(MIN, PERCENT of the headcount).
     */
    HEADCOUNT_TOLERANCE_PERCENT: z.coerce.number().int().min(0).max(100).default(15),
    HEADCOUNT_TOLERANCE_MIN: z.coerce.number().int().min(0).max(1000).default(3),
    /** Largest headcount a lecturer may enter. */
    HEADCOUNT_MAX: z.coerce.number().int().min(1).max(100_000).default(2000),
    /** A headcount older than this, with check-ins since, is shown as possibly out of date. */
    HEADCOUNT_STALE_MINUTES: z.coerce.number().int().min(1).max(1440).default(30),
    /** Spot checks: how many present students are sampled, and the most a lecturer may ask for. */
    SPOT_CHECK_DEFAULT_SIZE: z.coerce.number().int().min(1).max(1000).default(5),
    SPOT_CHECK_MAX_SIZE: z.coerce.number().int().min(1).max(1000).default(20),
    /** Students sampled in this many of the course's previous sessions are less likely to be picked. */
    SPOT_CHECK_HISTORY_SESSIONS: z.coerce.number().int().min(0).max(20).default(2),
    /** Each spot-check round also includes at least this many face-verified students, when any exist. */
    SPOT_CHECK_FACE_VERIFIED_MIN: z.coerce.number().int().min(0).max(100).default(1),
    /**
     * Per-address limits. A whole lecture hall on campus Wi-Fi shares one public address, so these
     * are generous by default: a class must be able to sign up together. Raise REGISTER if a large
     * intake is blocked; the per-account sign-in limit (5 failures) is the main guard on passwords.
     */
    REGISTER_MAX_PER_IP_PER_HOUR: z.coerce.number().int().min(1).max(100_000).default(100),
    LOGIN_MAX_FAILURES_PER_IP: z.coerce.number().int().min(1).max(100_000).default(30),
    /** Set when running behind a trusted reverse proxy so the client IP is read correctly. */
    TRUST_PROXY: booleanString,
    /**
     * Face-verification pilot. The verifier is `fake` (deterministic, for development and tests) or
     * `production` (a real vendor; the stub throws NOT_CONFIGURED until one is integrated). The
     * per-course flag gates whether checks happen at all; this only selects the implementation.
     */
    FACE_VERIFIER: z.enum(['fake', 'production']).default('production'),
    /**
     * Key that encrypts the vendor template reference at rest (AES-256-GCM): 32 bytes, base64url.
     * Required before any enrollment can be stored; without it the face routes refuse to enroll.
     */
    FACE_TEMPLATE_KEY: z.string().optional(),
    /** How long a supervised enrollment session stays open for the student to complete capture. */
    FACE_ENROLLMENT_SESSION_TTL_SECONDS: z.coerce.number().int().min(60).max(3600).default(300),
    /** The current privacy-notice version a student must have consented to before enrolling. */
    FACE_NOTICE_VERSION: z.string().min(1).max(100).default('2026-10-face-pilot-v1'),
    /** How long a single-use face-check challenge stays valid (seconds). */
    FACE_CHALLENGE_TTL_SECONDS: z.coerce.number().int().min(30).max(600).default(90),
    /** A match at or above this score (0–1), with a live capture, passes the check. */
    FACE_MATCH_THRESHOLD: z.coerce.number().min(0).max(1).default(0.8),
    /** How many attempts a student gets before the check is left for an in-person decision. */
    FACE_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(20).default(5),
    /** Liveness and match-score detail is deleted after this many days; the outcome is kept longer. */
    FACE_DETAIL_RETENTION_DAYS: z.coerce.number().int().min(1).max(3650).default(90),
  })
  .refine((c) => c.NODE_ENV !== 'production' || (c.RESEND_API_KEY && c.MAIL_FROM), {
    message: 'RESEND_API_KEY and MAIL_FROM are required in production',
    path: ['RESEND_API_KEY'],
  })
  .refine((c) => c.SPOT_CHECK_DEFAULT_SIZE <= c.SPOT_CHECK_MAX_SIZE, {
    message: 'SPOT_CHECK_DEFAULT_SIZE must not exceed SPOT_CHECK_MAX_SIZE',
    path: ['SPOT_CHECK_DEFAULT_SIZE'],
  })
  .refine((c) => !c.RESEND_API_KEY || c.MAIL_FROM, {
    message: 'MAIL_FROM is required when RESEND_API_KEY is set',
    path: ['MAIL_FROM'],
  })
  .refine((c) => !(c.NODE_ENV === 'production' && c.ALLOW_INSECURE_COOKIES), {
    message: 'ALLOW_INSECURE_COOKIES must not be enabled in production',
    path: ['ALLOW_INSECURE_COOKIES'],
  })
  .refine(
    (c) =>
      c.FACE_TEMPLATE_KEY === undefined ||
      Buffer.from(c.FACE_TEMPLATE_KEY, 'base64url').length >= 32,
    {
      message: 'FACE_TEMPLATE_KEY must be at least 32 bytes, base64url',
      path: ['FACE_TEMPLATE_KEY'],
    },
  );

export type Config = z.infer<typeof ConfigSchema>;

/** Parses and validates environment variables. Throws a readable error if anything is missing. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = ConfigSchema.safeParse(env);
  if (!parsed.success) {
    const problems = parsed.error.issues
      .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('; ');
    // Variable names only; values are never echoed because they may be secrets.
    throw new Error(`Invalid configuration: ${problems}`);
  }
  return parsed.data;
}

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
    /** Development convenience only: allows the session cookie over plain HTTP. */
    ALLOW_INSECURE_COOKIES: booleanString,
    /** Set when running behind a trusted reverse proxy so the client IP is read correctly. */
    TRUST_PROXY: booleanString,
  })
  .refine((c) => !(c.NODE_ENV === 'production' && c.ALLOW_INSECURE_COOKIES), {
    message: 'ALLOW_INSECURE_COOKIES must not be enabled in production',
    path: ['ALLOW_INSECURE_COOKIES'],
  });

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

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

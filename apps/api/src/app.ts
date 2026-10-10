import cookie from '@fastify/cookie';
import Fastify, { type FastifyInstance } from 'fastify';
import type pg from 'pg';
import { csrfGuard } from './auth/csrf.js';
import type { Mailer } from './auth/mailer.js';
import { registerAuthRoutes } from './auth/routes.js';
import type { Config } from './config.js';

export interface AppOptions {
  config: Config;
  pool: pg.Pool;
  mailer: Mailer;
  /** `true` for default logging, an options object (e.g. a custom stream), or `false`. */
  logger?: boolean | { level?: string; stream?: NodeJS.WritableStream };
}

// Credentials must never reach logs, even if request serialisation is widened later.
const REDACT = ['req.headers.cookie', 'req.headers.authorization', 'res.headers["set-cookie"]'];

/** Builds the Fastify instance without listening, so tests can drive it with inject(). */
export async function buildApp(options: AppOptions): Promise<FastifyInstance> {
  const { config, pool, mailer } = options;
  const logger =
    options.logger === true
      ? { redact: REDACT }
      : options.logger
        ? { ...options.logger, redact: REDACT }
        : false;

  const app = Fastify({ logger, trustProxy: config.TRUST_PROXY });

  await app.register(cookie);
  app.addHook('onRequest', csrfGuard(config));
  registerAuthRoutes(app, { config, pool, mailer });

  app.get('/healthz', async () => ({ status: 'ok' }));

  return app;
}

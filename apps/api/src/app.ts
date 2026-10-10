import { tmpdir } from 'node:os';
import { join } from 'node:path';
import cookie from '@fastify/cookie';
import Fastify, { type FastifyInstance } from 'fastify';
import type pg from 'pg';
import { registerAttendanceRoutes } from './attendance/routes.js';
import { csrfGuard } from './auth/csrf.js';
import { registerCheckInRoutes } from './checkin/routes.js';
import type { Mailer } from './auth/mailer.js';
import { registerAuthRoutes } from './auth/routes.js';
import { registerAuthorization } from './authz/index.js';
import type { Config } from './config.js';
import { registerExportRoutes } from './exports/routes.js';
import { LocalDiskStorage, type ExportStorage } from './exports/storage.js';
import { registerCourseRoutes } from './courses/routes.js';
import { parseKeyring } from './qr/token.js';
import { registerQrRoutes } from './qr/routes.js';
import { registerReviewRoutes } from './reviews/routes.js';
import { registerRosterRoutes } from './roster/routes.js';
import { registerSecurityHeaders } from './security/headers.js';
import { registerWeb } from './security/web.js';
import { registerSessionRoutes } from './sessions/routes.js';

export interface AppOptions {
  config: Config;
  pool: pg.Pool;
  mailer: Mailer;
  /** Where export files are kept until they expire. Defaults to a private local directory. */
  exportStorage?: ExportStorage;
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

  const app = Fastify({
    logger,
    trustProxy: config.TRUST_PROXY,
    // The web app calls the API under /api; routes themselves are registered without the prefix.
    rewriteUrl: (req) => (req.url?.startsWith('/api/') ? req.url.slice(4) : (req.url ?? '/')),
  });

  await app.register(cookie);
  registerSecurityHeaders(app, config);
  if (config.WEB_DIST_DIR) registerWeb(app, config.WEB_DIST_DIR);
  app.addHook('onRequest', csrfGuard(config));
  registerAuthorization(app, { pool });
  registerAuthRoutes(app, { config, pool, mailer });
  registerCourseRoutes(app, { pool });
  registerRosterRoutes(app, { pool });
  registerSessionRoutes(app, { pool });
  // Fails at start-up (not at first use) if the signing keys are missing or too short.
  const keyring = parseKeyring(config.QR_KEYS, config.QR_ACTIVE_KID);
  registerQrRoutes(app, { pool, config, keyring });
  registerCheckInRoutes(app, { pool, config, keyring });
  registerAttendanceRoutes(app, { pool });
  registerReviewRoutes(app, { pool });
  const storage =
    options.exportStorage ??
    new LocalDiskStorage(config.EXPORT_DIR ?? join(tmpdir(), 'scanin-exports'));
  registerExportRoutes(app, { pool, storage, ttlMinutes: config.EXPORT_TTL_MINUTES });

  app.get('/healthz', { config: { authz: { public: true } } }, async () => ({ status: 'ok' }));

  return app;
}

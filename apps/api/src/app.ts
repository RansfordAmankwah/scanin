import { tmpdir } from 'node:os';
import { join } from 'node:path';
import cookie from '@fastify/cookie';
import Fastify, { type FastifyInstance } from 'fastify';
import type pg from 'pg';
import { registerAntiProxyRoutes } from './antiproxy/routes.js';
import { registerAttendanceRoutes } from './attendance/routes.js';
import { csrfGuard } from './auth/csrf.js';
import { registerCheckInRoutes } from './checkin/routes.js';
import type { Mailer } from './auth/mailer.js';
import { registerAuthRoutes } from './auth/routes.js';
import { registerAuthorization } from './authz/index.js';
import type { Config } from './config.js';
import { registerExportRoutes } from './exports/routes.js';
import { LocalDiskStorage, type ExportStorage } from './exports/storage.js';
import { registerFaceRoutes } from './face/routes.js';
import { createFaceVerifier, type FaceVerifier } from './face/verifier.js';
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
  /** The face verifier. Defaults to the one named by FACE_VERIFIER; tests inject a fake to inspect it. */
  faceVerifier?: FaceVerifier;
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

  // One place decides what a caller sees when something goes wrong. Fastify's default handler
  // returns the raw error, which for a database failure includes the Postgres code, constraint and
  // table names. Here the detail goes to the log (cookies are redacted) and the caller gets a fixed
  // message and a request id they can quote.
  app.setErrorHandler((error: unknown, req, reply) => {
    const err = error as { statusCode?: number; name?: string; message?: string; code?: string };
    const status =
      typeof err.statusCode === 'number' && err.statusCode >= 400 ? err.statusCode : 500;
    if (status >= 500) {
      req.log.error(
        { reqId: req.id, err: { name: err.name, message: err.message, code: err.code } },
        'request failed',
      );
      return reply.code(status).send({
        error: {
          code: 'INTERNAL_ERROR',
          message: 'Something went wrong on our side. Please try again.',
          requestId: req.id,
        },
      });
    }
    // Framework-level client errors (malformed JSON, body too large, unsupported type): fixed text.
    const known: Record<number, string> = {
      400: 'The request could not be understood.',
      413: 'The request is too large.',
      415: 'That content type is not supported.',
    };
    return reply.code(status).send({
      error: {
        code: 'BAD_REQUEST',
        message: known[status] ?? 'The request could not be completed.',
      },
    });
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
  registerAntiProxyRoutes(app, { pool, config });
  const faceVerifier = options.faceVerifier ?? createFaceVerifier(config.FACE_VERIFIER);
  registerFaceRoutes(app, { pool, config, verifier: faceVerifier });
  const storage =
    options.exportStorage ??
    new LocalDiskStorage(config.EXPORT_DIR ?? join(tmpdir(), 'scanin-exports'));
  registerExportRoutes(app, { pool, storage, ttlMinutes: config.EXPORT_TTL_MINUTES });

  app.get('/healthz', { config: { authz: { public: true } } }, async () => ({ status: 'ok' }));

  return app;
}

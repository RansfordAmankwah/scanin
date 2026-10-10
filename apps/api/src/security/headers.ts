import type { FastifyInstance } from 'fastify';
import type { Config } from '../config.js';

/**
 * Browser-facing protections applied to every response.
 *
 *  - Content-Security-Policy: only our own scripts, styles and connections; no framing; images may
 *    be `data:` (the QR code is rendered to a data URL); workers may be `blob:` (camera scanner).
 *  - camera is allowed for this origin only; every other powerful feature is off.
 *  - API responses are never cached: they carry personal data and short-lived codes.
 *  - In production: HSTS, and plain-HTTP requests (as reported by the trusted proxy) are redirected
 *    to the configured HTTPS origin. Camera access requires HTTPS in any real deployment.
 */
export const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data: blob:",
  "connect-src 'self'",
  "worker-src 'self' blob:",
  "media-src 'self' blob:",
  "font-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

export const HSTS = 'max-age=31536000; includeSubDomains';

export function registerSecurityHeaders(
  app: FastifyInstance,
  config: Pick<Config, 'NODE_ENV' | 'TRUST_PROXY' | 'APP_ORIGIN'>,
): void {
  const production = config.NODE_ENV === 'production';

  app.addHook('onRequest', async (req, reply) => {
    if (!production || !config.TRUST_PROXY) return;
    const proto = req.headers['x-forwarded-proto'];
    // The health probe is called over plain HTTP by the platform, from inside the network.
    if (proto === 'http' && !req.url.startsWith('/healthz')) {
      // Redirect to the CONFIGURED origin, never to a Host header the client chose.
      await reply.code(308).header('Location', `${config.APP_ORIGIN}${req.url}`).send();
    }
  });

  app.addHook('onSend', async (_req, reply, payload) => {
    reply.header('Content-Security-Policy', CSP);
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'no-referrer');
    reply.header('X-Frame-Options', 'DENY');
    reply.header('Cross-Origin-Opener-Policy', 'same-origin');
    reply.header('Cross-Origin-Resource-Policy', 'same-origin');
    reply.header(
      'Permissions-Policy',
      'camera=(self), microphone=(), geolocation=(), payment=(), usb=()',
    );
    if (production) reply.header('Strict-Transport-Security', HSTS);
    if (!reply.hasHeader('Cache-Control')) reply.header('Cache-Control', 'no-store');
    return payload;
  });
}

import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Config } from '../config.js';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

// Server-to-server callbacks that authenticate themselves (a signed webhook) are cross-origin by
// nature and carry no browser headers, so CSRF does not apply. They verify their own signature.
const CSRF_EXEMPT = new Set(['/billing/webhook']);

/**
 * CSRF defence for a same-origin SPA using SameSite=Lax cookies. Every state-changing request must
 * come from the app's own origin AND carry a custom header that a cross-site form cannot set.
 * State-changing routes must never be GET.
 */
export function csrfGuard(config: Pick<Config, 'APP_ORIGIN'>) {
  return async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    if (SAFE_METHODS.has(req.method)) return;
    if (CSRF_EXEMPT.has((req.url.split('?')[0] ?? '').replace(/\/$/, ''))) return;

    const fetchSite = req.headers['sec-fetch-site'];
    const crossSite = typeof fetchSite === 'string' && fetchSite !== 'same-origin';
    const originOk = req.headers.origin === config.APP_ORIGIN;
    const headerOk = req.headers['x-requested-with'] === 'scanin';

    if (crossSite || !originOk || !headerOk) {
      await reply
        .code(403)
        .send({ error: { code: 'CSRF_REJECTED', message: 'Request rejected.' } });
    }
  };
}

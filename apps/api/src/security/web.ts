import { readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join, relative, sep } from 'node:path';
import type { FastifyInstance } from 'fastify';

/**
 * Serves the built web app, plus a small public, indexable marketing site, from the same origin as
 * the API (so cookies, CSRF and CORS stay trivial). The split:
 *
 *   /               static landing page; a signed-in visitor is 302'd to /sign-in, and it is never
 *                   cached across users (Cache-Control: private, no-store)
 *   /how-it-works   static public pages, indexable
 *   /privacy        a short general site privacy page (NOT the face-verification pilot notice)
 *   /robots.txt     real files (with correct content types), served before the SPA fallback
 *   /sitemap.xml
 *   everything else the single-page app shell, served with X-Robots-Tag: noindex so the signed-in
 *                   views are not indexed. robots.txt deliberately does not disallow these, so a
 *                   crawler can fetch them and see the noindex header.
 *
 * Files are read into memory once at start-up, so a request can never name a path on disk.
 */
const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.map': 'application/json; charset=utf-8',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
};

/** Clean URLs for the static public (indexable) pages → their built file. */
const PUBLIC_HTML: Record<string, string> = {
  '/how-it-works': '/how-it-works.html',
  '/privacy': '/privacy.html',
};

/**
 * Presence of a session cookie (`__Host-sid` in production, `sid` in dev). Used only to route a
 * signed-in visitor from the public landing to the app — it is routing, not authorisation, so a
 * stale or invalid cookie simply lands them on the app's own sign-in flow.
 */
const SESSION_COOKIE = /(?:^|;\s*)(?:__Host-sid|sid)=/;

interface Asset {
  body: Buffer;
  type: string;
  hashed: boolean;
}

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

export function loadAssets(distDir: string): Map<string, Asset> {
  const assets = new Map<string, Asset>();
  for (const file of walk(distDir)) {
    const url = '/' + relative(distDir, file).split(sep).join('/');
    const ext = extname(file).toLowerCase();
    assets.set(url, {
      body: readFileSync(file),
      type: TYPES[ext] ?? 'application/octet-stream',
      hashed: url.startsWith('/assets/'),
    });
  }
  if (!assets.has('/index.html'))
    throw new Error(`No index.html in ${distDir}; build the web app first`);
  return assets;
}

const wantsHtml = (accept: string | undefined): boolean => !!accept && accept.includes('text/html');

export function registerWeb(app: FastifyInstance, distDir: string): void {
  const assets = loadAssets(distDir);

  app.addHook('onRequest', async (req, reply) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return;
    const original = req.originalUrl ?? req.url;
    if (original.startsWith('/api/') || original === '/healthz') return; // API traffic

    const path = original.split('?')[0] ?? '/';

    // The landing page. A signed-in visitor goes straight to the app; the page is never cached
    // across users, so Cloudflare cannot serve one person's redirect (or lack of one) to another.
    if (path === '/') {
      void reply.header('Cache-Control', 'private, no-store');
      if (SESSION_COOKIE.test(req.headers.cookie ?? '')) {
        return reply.redirect('/sign-in', 302);
      }
      const landing = assets.get('/landing.html');
      if (landing) {
        await reply.header('Content-Type', landing.type).send(landing.body);
        return;
      }
      return; // landing not built yet
    }
    // Never expose the landing under its own filename; keep one canonical URL.
    if (path === '/landing.html') return reply.redirect('/', 301);

    // Static public pages at clean URLs — indexable, no noindex header.
    const pageAsset = PUBLIC_HTML[path] ? assets.get(PUBLIC_HTML[path]!) : undefined;
    if (pageAsset) {
      await reply
        .header('Content-Type', pageAsset.type)
        .header('Cache-Control', 'public, max-age=3600')
        .send(pageAsset.body);
      return;
    }

    // Any other real file: hashed bundles, the favicon, robots.txt, sitemap.xml, the OG image.
    const asset = assets.get(path);
    if (asset && path !== '/index.html') {
      await reply
        .header('Content-Type', asset.type)
        .header(
          'Cache-Control',
          asset.hashed ? 'public, max-age=31536000, immutable' : 'public, max-age=3600',
        )
        .send(asset.body);
      return;
    }

    // The single-page app shell for every signed-in route. Marked noindex: these views require a
    // session and must never be indexed, whatever path a crawler guesses.
    if (wantsHtml(req.headers.accept) || path === '/index.html') {
      await reply
        .header('Content-Type', TYPES['.html'])
        .header('Cache-Control', 'no-cache')
        .header('X-Robots-Tag', 'noindex')
        .send(assets.get('/index.html')?.body);
    }
  });
}

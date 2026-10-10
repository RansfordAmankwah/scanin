import { readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join, relative, sep } from 'node:path';
import type { FastifyInstance } from 'fastify';

/**
 * Serves the built web app from the same origin as the API, so cookies, CSRF checks and CORS stay
 * trivial. API calls from the app use the /api prefix (stripped before routing); a browser
 * navigation to any other path gets index.html and the app's own router takes over.
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
};

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
    // A page navigation (not a fetch): hand the app its shell; its router decides what to show.
    if (wantsHtml(req.headers.accept) || path === '/' || path === '/index.html') {
      await reply
        .header('Content-Type', TYPES['.html'])
        .header('Cache-Control', 'no-cache')
        .send(assets.get('/index.html')?.body);
    }
  });
}

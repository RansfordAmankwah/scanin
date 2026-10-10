import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp } from './app.js';
import { DevConsoleMailer, ResendMailer } from './auth/mailer.js';
import { loadConfig } from './config.js';
import { createPool } from './db/pool.js';
import { FileCheckpointSink, startCheckpointJob } from './audit/checkpoint.js';
import { startExportExpiry } from './exports/service.js';
import { LocalDiskStorage } from './exports/storage.js';
import { startRetentionJob } from './retention/service.js';
import { startSessionSweeper } from './sessions/service.js';

const config = loadConfig();
const pool = createPool(config.DATABASE_URL);
// Production requires Resend (config enforces it); development falls back to printing links.
const mailer =
  config.RESEND_API_KEY && config.MAIL_FROM
    ? new ResendMailer(config.RESEND_API_KEY, config.MAIL_FROM)
    : new DevConsoleMailer(config.NODE_ENV);
const exportStorage = new LocalDiskStorage(config.EXPORT_DIR ?? join(tmpdir(), 'scanin-exports'));
const app = await buildApp({ config, pool, mailer, exportStorage, logger: true });

// Materialises deadline closures; correctness never depends on it (see sessions/service.ts).
const stopSweeper = startSessionSweeper(pool, (err) =>
  app.log.error({ err: (err as Error).message }, 'session sweeper failed'),
);
const stopExpiry = startExportExpiry(pool, exportStorage, (err) =>
  app.log.error({ err: (err as Error).message }, 'export expiry failed'),
);
const stops: Array<() => void> = [stopSweeper, stopExpiry];

// Daily retention purge, as the dedicated read+delete database role. Off unless configured.
if (config.RETENTION_DATABASE_URL) {
  const retentionPool = createPool(config.RETENTION_DATABASE_URL);
  stops.push(
    startRetentionJob(
      retentionPool,
      (report) => app.log.info({ report }, 'retention run complete'),
      (err) => app.log.error({ err: (err as Error).message }, 'retention run failed'),
    ),
    () => void retentionPool.end(),
  );
} else {
  app.log.warn('RETENTION_DATABASE_URL is not set: expired data will NOT be purged automatically');
}

// Optional tamper evidence: copy audit fingerprints somewhere the database owner does not control.
if (config.AUDIT_CHECKPOINT_DIR) {
  stops.push(
    startCheckpointJob(pool, new FileCheckpointSink(config.AUDIT_CHECKPOINT_DIR), (err) =>
      app.log.error({ err: (err as Error).message }, 'audit checkpoint failed'),
    ),
  );
}

app.addHook('onClose', async () => {
  for (const stop of stops) stop();
});

try {
  // A generous backlog lets a lecture hall's burst of connections queue instead of being refused.
  await app.listen({ port: config.API_PORT, host: '0.0.0.0', backlog: 1024 });
} catch (err) {
  app.log.error(err);
  process.exit(1);
}

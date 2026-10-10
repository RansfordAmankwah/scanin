import { buildApp } from './app.js';
import { DevConsoleMailer } from './auth/mailer.js';
import { loadConfig } from './config.js';
import { createPool } from './db/pool.js';

const config = loadConfig();
const pool = createPool(config.DATABASE_URL);
// A real mail provider is an open decision; production start-up fails until one is wired in.
const mailer = new DevConsoleMailer(config.NODE_ENV);
const app = await buildApp({ config, pool, mailer, logger: true });

try {
  await app.listen({ port: config.API_PORT, host: '0.0.0.0' });
} catch (err) {
  app.log.error(err);
  process.exit(1);
}

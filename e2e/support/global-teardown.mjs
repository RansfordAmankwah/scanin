import { readFileSync, rmSync } from 'node:fs';
import pg from 'pg';

/** Stops the server and removes the throwaway database and roles. */
export default async function globalTeardown() {
  const statePath = process.env.SCANIN_E2E_STATE;
  if (!statePath) return;
  const state = JSON.parse(readFileSync(statePath, 'utf8'));

  try {
    process.kill(state.pid);
  } catch {
    // already gone
  }
  await new Promise((r) => setTimeout(r, 500));

  const admin = new pg.Client({ connectionString: state.adminUrl });
  await admin.connect();
  try {
    for (let i = 0; i < 40; i++) {
      try {
        await admin.query(`DROP DATABASE IF EXISTS ${state.dbName}`);
        break;
      } catch (err) {
        if (err.code !== '55006') throw err; // still in use: the server is shutting down
        await new Promise((r) => setTimeout(r, 250));
      }
    }
    for (const role of Object.values(state.roles))
      await admin.query(`DROP ROLE IF EXISTS "${role}"`);
  } finally {
    await admin.end();
  }
  rmSync(state.exportDir, { recursive: true, force: true });
  rmSync(statePath, { force: true });
}

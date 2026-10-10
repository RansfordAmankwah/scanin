import { defineConfig } from '@playwright/test';

/**
 * Real-browser tests of the production build. Locally they drive the Microsoft Edge that ships with
 * Windows (so no browser download is needed); in CI set PLAYWRIGHT_CHANNEL=chromium after
 * `npx playwright install chromium`.
 */
export const CHANNEL =
  process.env.PLAYWRIGHT_CHANNEL === 'chromium'
    ? undefined
    : (process.env.PLAYWRIGHT_CHANNEL ?? 'msedge');

export default defineConfig({
  testDir: './tests',
  outputDir: './test-results/artifacts',
  globalSetup: './support/global-setup.mjs',
  globalTeardown: './support/global-teardown.mjs',
  // One server, one database: tests share state in a deliberate order.
  workers: 1,
  fullyParallel: false,
  timeout: 90_000,
  expect: { timeout: 15_000 },
  reporter: [['list'], ['json', { outputFile: './test-results/report.json' }]],
  use: {
    channel: CHANNEL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
});

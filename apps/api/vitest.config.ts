import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// The repo-root .env holds local-only settings such as TEST_DATABASE_ADMIN_URL. Variables already
// present in the environment (e.g. in CI) take precedence, and a missing file is fine.
try {
  process.loadEnvFile(fileURLToPath(new URL('../../.env', import.meta.url)));
} catch {
  // No local .env.
}

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // Latency-threshold tests are noisy on a busy machine; run them on demand: pnpm test:load
    exclude: ['test/load/**', 'node_modules/**'],
    // Database tests create and drop their own throwaway databases; keep files serial for now.
    fileParallelism: false,
    testTimeout: 20_000,
  },
});

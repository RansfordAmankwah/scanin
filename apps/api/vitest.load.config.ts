import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

try {
  process.loadEnvFile(fileURLToPath(new URL('../../.env', import.meta.url)));
} catch {
  // No local .env.
}

// Load tests: real HTTP, real sockets, strict latency thresholds. Run on a quiet machine or in CI.
export default defineConfig({
  test: {
    include: ['test/load/**/*.test.ts'],
    fileParallelism: false,
    testTimeout: 180_000,
    hookTimeout: 60_000,
  },
});

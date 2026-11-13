import { defineConfig } from 'vitest/config';

// Integration tests run against the MariaDB container (docker compose up -d db),
// in a separate "<DB_NAME>_test" database that the global setup creates.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.int.test.ts'],
    globalSetup: ['test/integration/global-setup.ts'],
    env: { NODE_ENV: 'test' },
    // The files share one database, so they must not run at the same time.
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});

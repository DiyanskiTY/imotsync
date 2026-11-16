import { configDefaults, defineConfig } from 'vitest/config';

// Unit tests: no database, no network. Integration tests live in *.int.test.ts
// and run with vitest.integration.config.ts.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    exclude: [...configDefaults.exclude, 'test/**/*.int.test.ts'],
    env: { NODE_ENV: 'test' },
    // No test may reach a host other than this machine (a real portal above all).
    setupFiles: ['test/support/network-guard.ts'],
  },
});

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Same temp HOME + no-token isolation as core (#1801).
    setupFiles: ['../core/src/test-lib/isolate-home.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts'],
      thresholds: {
        statements: 75,
        branches: 65,
        functions: 75,
        lines: 75,
      },
    },
  },
});

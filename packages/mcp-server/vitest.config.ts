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
        // Per-file floor for the approval gate and the MCP config refusals
        // (#2054): the gate above is aggregate, so this file could lose its
        // tests without tripping it. About 4 points under the value measured
        // on 2026-11-27 (statements/branches/functions/lines):
        //   trust-boundary.ts  98.73 / 95.45 / 100 / 100
        'src/trust-boundary.ts': { statements: 94, branches: 91, functions: 96, lines: 96 },
      },
    },
  },
});

import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude, 'dist/**'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'text-summary'],
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'src/**/*.e2e.test.ts', 'src/cli.ts', 'src/**/index.ts', 'src/test-lib/**'],
      // cli-registry.ts was fully excluded from coverage until #1454, hiding
      // ~1,700 lines (including executeAction's branching) from the gate. Its
      // handlers are mostly exercised through the e2e suites, which run the
      // esbuild bundle as a subprocess and therefore produce no in-process
      // coverage, so its instrumented numbers sit well below 80%. Vitest 4
      // checks bare global thresholds against ALL files (glob matches are NOT
      // carved out), so the gate is expressed as two glob sets instead:
      //   - everything except cli-registry.ts keeps the original 80% gate
      //     (picomatch negation; both sets are aggregate, not per-file);
      //   - cli-registry.ts gets honest floors at its current level so
      //     regressions fail CI. Ratchet these up as direct tests are added
      //     (tracked in #1586).
      thresholds: {
        '!src/cli-registry.ts': {
          statements: 80,
          branches: 80,
          functions: 80,
          lines: 80,
        },
        // First ratchet (#1586): direct handler tests for status, strategy,
        // daily, track, compliance-score, comments, post, and claim lifted
        // measured coverage to 42.85/30.81/55.55/43.06.
        'src/cli-registry.ts': {
          statements: 42,
          branches: 30,
          functions: 55,
          lines: 42,
        },
      },
    },
  },
});

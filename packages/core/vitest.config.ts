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
      //   - cli-registry.ts has its own floors, set ~2 points under the
      //     measured value. That slack is ~45 statements, so the gate catches
      //     an untested new command or a deleted describe block, not a single
      //     dropped `it`. When a new command lands, add its
      //     cli-registry.test.ts cases in the same PR so the floors hold.
      thresholds: {
        '!src/cli-registry.ts': {
          statements: 80,
          branches: 80,
          functions: 80,
          lines: 80,
        },
        // Ratchet history (#1586): first pass (status, strategy, daily, track,
        // compliance-score, comments, post, claim) measured 42.85/30.81/55.55/43.06;
        // second pass covered every remaining handler plus executeAction's
        // schema-mismatch and stdin paths and measured 99.68/90.33/100/99.84.
        'src/cli-registry.ts': {
          statements: 97,
          branches: 88,
          functions: 98,
          lines: 97,
        },
      },
    },
  },
});

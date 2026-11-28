import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude, 'dist/**'],
    setupFiles: ['src/test-lib/isolate-home.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'text-summary'],
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'src/**/*.e2e.test.ts', 'src/cli.ts', 'src/**/index.ts', 'src/test-lib/**'],
      // src/cli.ts stays excluded: it parses argv and may call process.exit on
      // import, so it cannot be loaded in-process. It is kept to wiring only
      // (program setup, first-run banner, parseAsync); the preAction hook lives
      // in cli-pre-action.ts, which IS instrumented and tested directly.
      //
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
        // Per-file floors for the unattended-write guard and the state it
        // protects (#1945): the 80% gate above is aggregate, so any of these
        // could lose all its tests without tripping it. Each floor sits about
        // 4 points under the value measured on 2026-11-19
        // (statements/branches/functions/lines). The comments.ts and
        // gist-state-store.ts rows were re-measured on 2026-11-20 after the
        // branch tests from #2003, and only their branch floors were raised:
        //   overnight-push-prep.ts  96.19 / 95.62 / 100   / 98.06
        //   comments.ts             99.01 / 97.01 / 94.44 / 100
        //   errors.ts               92.85 / 92.72 / 90.47 / 95.74
        //   state-persistence.ts    94.29 / 91.00 / 100   / 94.18
        //   gist-state-store.ts     98.50 / 92.07 / 100   / 98.87
        'src/commands/overnight-push-prep.ts': { statements: 92, branches: 91, functions: 96, lines: 94 },
        'src/commands/comments.ts': { statements: 89, branches: 93, functions: 90, lines: 91 },
        'src/core/errors.ts': { statements: 88, branches: 88, functions: 86, lines: 91 },
        'src/core/state-persistence.ts': { statements: 90, branches: 87, functions: 96, lines: 90 },
        'src/core/gist-state-store.ts': { statements: 83, branches: 88, functions: 96, lines: 87 },
        // The PR preflight and repo-policy gates (#2054), same rule, measured
        // on 2026-11-27 after #2061:
        //   commands/policy.ts        96.12 / 95.60 / 92.59 / 98.09
        //   commands/pr-preflight.ts  99.32 / 93.69 / 100   / 100
        //   core/pr-preflight.ts      99.60 / 98.61 / 100   / 100
        //   core/repo-policy.ts       98.95 / 95.39 / 100   / 100
        'src/commands/policy.ts': { statements: 92, branches: 91, functions: 88, lines: 94 },
        'src/commands/pr-preflight.ts': { statements: 95, branches: 89, functions: 96, lines: 96 },
        'src/core/pr-preflight.ts': { statements: 95, branches: 94, functions: 96, lines: 96 },
        'src/core/repo-policy.ts': { statements: 94, branches: 91, functions: 96, lines: 96 },
      },
    },
  },
});

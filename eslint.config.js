import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';
import eslintConfigPrettier from 'eslint-config-prettier';
import importX from 'eslint-plugin-import-x';
import nodePlugin from 'eslint-plugin-n';
import promise from 'eslint-plugin-promise';
import * as regexp from 'eslint-plugin-regexp';
import vitest from '@vitest/eslint-plugin';
import unicorn from 'eslint-plugin-unicorn';
import sonarjs from 'eslint-plugin-sonarjs';

// Helper: take a flat-config preset and downgrade every rule it sets to 'warn'.
// Used to onboard opinionated plugins (unicorn, sonarjs) without gating CI
// while we triage. Ratchet to 'error' as warning counts drop.
function downgradeToWarn(config) {
  return {
    ...config,
    rules: Object.fromEntries(
      Object.entries(config.rules ?? {}).map(([rule, value]) => [
        rule,
        Array.isArray(value) ? ['warn', ...value.slice(1)] : 'warn',
      ]),
    ),
  };
}

export default tseslint.config(
  eslint.configs.recommended,
  // Type-aware preset for source files only (test files are excluded from
  // per-package tsconfig.json — see scoped block below).
  ...tseslint.configs.recommendedTypeChecked,
  importX.flatConfigs.recommended,
  // Skip importX.flatConfigs.typescript — typescript-eslint already handles
  // module resolution; the import-x typescript resolver fights it and emits
  // 220 spurious "invalid interface loaded as resolver" warnings.
  nodePlugin.configs['flat/recommended-module'],
  promise.configs['flat/recommended'],
  regexp.configs['flat/recommended'],
  // Unicorn + SonarJS as warnings — opinionated rule sets we want to surface
  // gradually rather than gate CI on. See downgradeToWarn comment.
  downgradeToWarn(unicorn.configs.recommended),
  downgradeToWarn(sonarjs.configs.recommended),
  eslintConfigPrettier,
  {
    ignores: [
      'packages/*/dist/**',
      'packages/*/docs/**',
      'packages/*/coverage/**',
      'node_modules/**',
      '*.cjs',
    ],
  },
  {
    languageOptions: {
      parserOptions: {
        // projectService discovers tsconfig.json per-package automatically.
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // Allow unused vars prefixed with _ (common pattern)
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
          destructuredArrayIgnorePattern: '^_',
        },
      ],
      // Warn on explicit any in production code; test files override this to off
      '@typescript-eslint/no-explicit-any': 'warn',
      // Allow non-null assertion (used in tests)
      '@typescript-eslint/no-non-null-assertion': 'off',

      // ── Type-aware rules — kept as ERROR (these catch real bugs) ─────
      // no-floating-promises catches the audit's silent-failure pattern;
      // no-misused-promises catches passing async fns where sync is expected.
      '@typescript-eslint/no-floating-promises': 'error',
      // Allow async functions as React event handlers and as Node http.createServer
      // callbacks — both APIs handle returned promises fine. Still catches
      // higher-signal cases like `if (asyncFn())` and conditional checks.
      '@typescript-eslint/no-misused-promises': [
        'error',
        { checksVoidReturn: { arguments: false, attributes: false, properties: false } },
      ],
      '@typescript-eslint/no-base-to-string': 'error',
      '@typescript-eslint/prefer-promise-reject-errors': 'error',

      // ── Type-aware rules — downgraded to WARN ───────────────────────
      // The unsafe-* family fires heavily on JSON.parse, env vars, third-party
      // returns. Each one needs hand-review; warn level keeps them visible
      // without gating CI. Ratchet to error once the warning count is low.
      '@typescript-eslint/no-unsafe-assignment': 'warn',
      '@typescript-eslint/no-unsafe-member-access': 'warn',
      '@typescript-eslint/no-unsafe-call': 'warn',
      '@typescript-eslint/no-unsafe-argument': 'warn',
      '@typescript-eslint/no-unsafe-return': 'warn',
      '@typescript-eslint/restrict-template-expressions': 'warn',
      '@typescript-eslint/require-await': 'warn',
      '@typescript-eslint/no-unnecessary-type-assertion': 'warn',
      '@typescript-eslint/no-redundant-type-constituents': 'warn',

      // import-x: dev dependencies are fine in tests + tooling
      'import-x/no-unresolved': 'off', // typescript-eslint handles resolution
      'import-x/named': 'off', // ditto
      'import-x/namespace': 'off', // ditto
      'import-x/default': 'off', // ditto

      // n: turn off rules covered by typescript-eslint or that conflict with bundling
      'n/no-missing-import': 'off', // typescript-eslint handles this
      'n/no-unpublished-import': 'off', // false positives in workspace
      'n/no-extraneous-import': 'off', // workspace deps confuse this
      'n/no-process-exit': 'off', // this is a CLI — exit codes are required
      // The hashbang rule wants `#!/usr/bin/env node` only when the file is
      // listed in package.json `bin`. Our bin field points at the bundled
      // dist/cli.bundle.cjs (built by esbuild from src/cli.ts), so the rule
      // can't see the source files as bin entries. Source files DO need the
      // shebang — esbuild copies it through to the bundle, and the CI verify
      // step grep's for it. Disable globally; entry points keep the shebang.
      'n/hashbang': 'off',

      // ── Opinionated unicorn/sonarjs rules disabled (signal:noise too low) ──
      // Variable naming — too subjective; we have established conventions
      'unicorn/prevent-abbreviations': 'off',
      // null vs undefined — codebase intentionally uses null for "absent"
      // (matches GitHub API, JSON, and our Zod schemas)
      'unicorn/no-null': 'off',
      // wants `(error)` not `(err)` — bikeshed; codebase uses both
      'unicorn/catch-error-name': 'off',
      // wants `(arg) => ...` over `arg => ...` — prettier already enforces
      'sonarjs/arrow-function-convention': 'off',
      // flags any string literal repeated 3+ times — false positive heaven
      // for CLI tools where flag/option strings recur intentionally
      'sonarjs/no-duplicate-string': 'off',
      // wants a copyright header in every file — we don't use them
      'sonarjs/file-header': 'off',
      // wants explicit `=== undefined` over destructured defaults — noisy
      'sonarjs/no-undefined-assignment': 'off',
      // already covered by typescript-eslint's import resolution
      'sonarjs/no-wildcard-import': 'off',
      // false positive on ES modules — top-level declarations are module-
      // scoped, not global. Rule is designed for legacy script files.
      'sonarjs/declarations-in-global-scope': 'off',
      // false positive on Node globals (`process`, `Buffer`) — sonarjs
      // doesn't load @types/node
      'sonarjs/no-reference-error': 'off',
    },
  },
  {
    // Test files are excluded from per-package tsconfig.json (they don't ship
    // in dist). Disable type-aware rules for them — vitest already provides
    // type checking at runtime. The high-value rules (no-floating-promises,
    // no-misused-promises) primarily catch bugs in production code paths,
    // not test setup.
    files: [
      '**/*.test.ts',
      '**/*.test.tsx',
      '**/*.e2e.test.ts',
      '**/vitest.config.ts',
      '**/vitest.setup.ts',
      '**/vite.config.ts',
    ],
    ...tseslint.configs.disableTypeChecked,
    plugins: { vitest },
    rules: {
      ...tseslint.configs.disableTypeChecked.rules,
      '@typescript-eslint/no-explicit-any': 'off',
      ...vitest.configs.recommended.rules,
      // Allow `it.skip` for gated tests; project uses `it.todo` for stubs
      'vitest/no-disabled-tests': 'warn',
      // Conditional expects sometimes the right pattern (loop+branch tests);
      // surface as warn so they're visible but don't gate CI
      'vitest/no-conditional-expect': 'warn',
      'vitest/no-standalone-expect': 'warn',
      // Vitest accepts a 2nd arg to expect() as a custom error message
      // (jest does not). The plugin's default of maxArgs=1 mismatches the
      // actual vitest API; bump to allow the documented form.
      'vitest/valid-expect': ['error', { maxArgs: 2 }],
    },
  },
);

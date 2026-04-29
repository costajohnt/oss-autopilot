import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';
import eslintConfigPrettier from 'eslint-config-prettier';
import importX from 'eslint-plugin-import-x';
import nodePlugin from 'eslint-plugin-n';
import promise from 'eslint-plugin-promise';
import * as regexp from 'eslint-plugin-regexp';
import vitest from '@vitest/eslint-plugin';

export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  importX.flatConfigs.recommended,
  // Skip importX.flatConfigs.typescript — typescript-eslint already handles
  // module resolution; the import-x typescript resolver fights it and emits
  // 220 spurious "invalid interface loaded as resolver" warnings.
  nodePlugin.configs['flat/recommended-module'],
  promise.configs['flat/recommended'],
  regexp.configs['flat/recommended'],
  eslintConfigPrettier,
  {
    ignores: ['packages/*/dist/**', 'packages/*/docs/**', 'node_modules/**', '*.cjs'],
  },
  {
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
    },
  },
  {
    // Test files use `any` extensively for mocking — keep it off there
    files: ['**/*.test.ts'],
    plugins: { vitest },
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      ...vitest.configs.recommended.rules,
      // Allow `it.skip` for gated tests; project uses `it.todo` for stubs
      'vitest/no-disabled-tests': 'warn',
      // Conditional expects sometimes the right pattern (loop+branch tests);
      // surface as warn so they're visible but don't gate CI
      'vitest/no-conditional-expect': 'warn',
      'vitest/no-standalone-expect': 'warn',
    },
  },
);

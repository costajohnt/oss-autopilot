import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';
import eslintConfigPrettier from 'eslint-config-prettier';

export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
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
    },
  },
  {
    // Test files use `any` extensively for mocking — keep it off there
    files: ['**/*.test.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
);

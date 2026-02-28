import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude, 'dist/**'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'text-summary'],
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'src/**/*.e2e.test.ts'],
      thresholds: {
        statements: 50,
        branches: 40,
        functions: 55,
        lines: 50,
      },
    },
  },
});

import { defineConfig } from 'vitest/config';
import preact from '@preact/preset-vite';

export default defineConfig({
  plugins: [preact()],
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./vitest.setup.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'text-summary'],
      include: ['src/**/*.{ts,tsx}'],
      exclude: ['src/**/*.test.{ts,tsx}', 'src/index.tsx', 'src/test-helpers.ts', 'src/types.ts'],
      // CI's coverage step runs `pnpm -r run test:coverage`, which silently
      // skips packages without the script — this package had neither the
      // script nor thresholds, so its coverage was unmeasured and ungated
      // while core/mcp-server were enforced (#1375).
      // Floors set ~5-10 points under measured reality (89.9/81.9/85.3/90.6
      // at introduction) so the gate catches decay without being brittle.
      thresholds: {
        statements: 80,
        branches: 75,
        functions: 80,
        lines: 80,
      },
    },
  },
});

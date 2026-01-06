import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Run tests sequentially to avoid state file conflicts
    fileParallelism: false,
    testTimeout: 10000,
  },
});

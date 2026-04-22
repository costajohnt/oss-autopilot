import { defineConfig } from 'vite';
import preact from '@preact/preset-vite';

export default defineConfig({
  plugins: [preact()],
  resolve: {
    dedupe: ['preact', 'preact/hooks'],
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    // Emit source maps to dist/ for local debugging but don't reference them
    // from the built JS, so prod users don't see `sourceMappingURL` (#1058 M39).
    sourcemap: 'hidden',
  },
  server: {
    proxy: {
      '/api': 'http://127.0.0.1:3001',
    },
  },
});

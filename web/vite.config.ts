import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  plugins: [react()],
  build: { outDir: 'dist', emptyOutDir: true },
  server: { port: 4821, strictPort: true, proxy: { '/api': { target: 'http://127.0.0.1:4822', changeOrigin: true } } },
  test: { include: ['src/**/*.test.ts'], environment: 'node' },
});

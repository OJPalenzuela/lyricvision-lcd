import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Scoped so the default run never executes the legacy CommonJS plain-assert
// scripts (tests/test_*.js): only *.test.* under tests/renderer (jsdom) and
// tests/unit (node, via per-file @vitest-environment) are collected.
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src/renderer'),
    },
  },
  test: {
    environment: 'jsdom',
    include: [
      'tests/renderer/**/*.test.{ts,tsx}',
      'tests/unit/**/*.test.{js,ts,tsx}',
    ],
    setupFiles: ['tests/setup.ts'],
  },
});

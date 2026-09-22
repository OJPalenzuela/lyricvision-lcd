import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Dev-only CSP relaxation: allows Vite's HMR websocket + injected styles.
// Production builds keep the strict meta from src/renderer/index.html untouched.
const DEV_CSP =
  "default-src 'self'; " +
  "script-src 'self' 'unsafe-inline'; " +
  "style-src 'self' 'unsafe-inline'; " +
  "img-src 'self' data:; " +
  "object-src 'none'; " +
  "base-uri 'self'; " +
  "form-action 'none'; " +
  "connect-src 'self' ws://localhost:* http://localhost:*";

export default defineConfig(({ command }) => ({
  plugins: [
    react(),
    tailwindcss(),
    {
      name: 'lyricvision-dev-csp',
      transformIndexHtml(html) {
        if (command !== 'serve') return html;
        return html.replace(
          /<meta[^>]*http-equiv="Content-Security-Policy"[^>]*>/,
          `<meta http-equiv="Content-Security-Policy" content="${DEV_CSP}" />`
        );
      },
    },
  ],
  root: 'src/renderer',
  // Relative asset base: the production window loads this over file://
  // (mainWindow.loadFile), where a root-absolute /assets/... would resolve
  // to file:///assets/... and render a blank window. Dev keeps '/' so the
  // HMR websocket and module URLs resolve against the Vite server root.
  base: command === 'build' ? './' : '/',
  build: {
    outDir: path.resolve(__dirname, 'dist/renderer'),
    emptyOutDir: true,
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src/renderer'),
    },
  },
}));

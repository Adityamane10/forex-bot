import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath, URL } from 'node:url';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@fx/shared': fileURLToPath(new URL('../shared/src/index.ts', import.meta.url)),
    },
  },
  server: {
    port: 5173,
    // Bind ALL interfaces (0.0.0.0): Vite's default 'localhost' resolves to
    // ::1 on some Windows hosts and binds IPv6-only, leaving 127.0.0.1:5173
    // refused. 'true' makes both localhost:5173 and LAN access work.
    host: true,
    proxy: {
      '/api': {
        // Honor the compose-provided target (VITE_API_TARGET) — the old
        // hardcoded 127.0.0.1 pointed at the container's OWN loopback.
        target: process.env.VITE_API_TARGET ?? 'http://127.0.0.1:4000',
        changeOrigin: true,
        ws: true,
      },
      '/socket.io': {
        target: process.env.VITE_API_TARGET ?? 'http://127.0.0.1:4000',
        changeOrigin: true,
        ws: true,
      },
    },
  },
  preview: {
    port: 4173,
    proxy: {
      '/api': {
        target: process.env.VITE_API_TARGET ?? 'http://127.0.0.1:4000',
        changeOrigin: true,
        ws: true,
      },
      '/socket.io': {
        target: process.env.VITE_API_TARGET ?? 'http://127.0.0.1:4000',
        changeOrigin: true,
        ws: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
  },
  test: {
    // socket.ts reads import.meta.env.VITE_API_URL at module-load time and
    // pulls in socket.io-client which calls browser globals — running vitest
    // under node made candleInPlace.test.ts explode with "window is not
    // defined". happy-dom is ~10x smaller than jsdom and fast enough for our
    // tiny test suite; switch to jsdom if a test needs richer DOM semantics.
    environment: 'happy-dom',
    globals: true,
  },
});

import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';

// Dev: Vite serves the client on 5173 and proxies /ws to the simulation server.
// Prod: `npm run build` emits client/dist, which the server serves directly.
export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  publicDir: 'public',
  server: {
    port: 5173,
    proxy: {
      '/ws': { target: 'ws://localhost:3001', ws: true },
    },
  },
  build: { outDir: 'dist', emptyOutDir: true },
});

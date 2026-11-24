import { defineConfig } from 'vite';

// The dev server proxies the relay routes, so the page talks to its own origin (no CORS).
const relayPort = process.env['WEAVE_RELAY_PORT'] ?? '8787';

export default defineConfig({
  server: {
    port: Number(process.env['FIELDNOTE_PORT'] ?? 5173),
    strictPort: true,
    proxy: { '/v1': `http://127.0.0.1:${relayPort}` },
  },
  build: { target: 'es2022' },
});

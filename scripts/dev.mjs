// Starts an app for local development (design 13): a `weave-relay` process on port 8787 and the
// app's Vite dev server, which proxies `/v1/*` to the relay so the browser needs no CORS.
//
//   npm run dev:ghostline      npm run dev:fieldnote
//
// Optional: WEAVE_RELAY_TOKEN (passed to both sides), WEAVE_RELAY_DATA (default ./relay-data/<app>).
// Open http://localhost:5173/?device=alice and a second tab with ?device=bob.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const app = process.argv[2];
if (app !== 'ghostline' && app !== 'fieldnote') {
  console.error('usage: node scripts/dev.mjs <ghostline|fieldnote>');
  process.exit(2);
}
const cli = path.join(root, 'packages/relay/dist/cli.js');
if (!existsSync(cli)) {
  console.error('Build first: npm run build');
  process.exit(2);
}

const port = process.env.WEAVE_RELAY_PORT ?? '8787';
const relay = spawn(process.execPath, [cli], {
  env: {
    ...process.env,
    WEAVE_RELAY_PORT: port,
    WEAVE_RELAY_DATA: process.env.WEAVE_RELAY_DATA ?? path.join(root, 'relay-data', app),
  },
  stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
});
const vite = spawn(
  process.execPath,
  [path.join(root, 'node_modules/vite/bin/vite.js'), '--host', '127.0.0.1'],
  {
    cwd: path.join(root, 'apps', app),
    env: { ...process.env, WEAVE_RELAY_PORT: port },
    stdio: 'inherit',
  },
);

let stopping = false;
const stop = () => {
  if (stopping) return;
  stopping = true;
  vite.kill();
  // The relay may already have exited (for example STORAGE_LOCKED at startup): only signal a
  // running relay, so a closed IPC channel never hides the relay's own error.
  if (relay.exitCode !== null || relay.signalCode !== null) return;
  if (process.platform === 'win32' && relay.connected) relay.send('shutdown');
  else relay.kill('SIGTERM');
};
relay.on('error', (e) => console.error(`relay: ${e.message}`));
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
relay.once('exit', (code) => {
  stop();
  if (code) process.exitCode = code;
});
vite.once('exit', stop);

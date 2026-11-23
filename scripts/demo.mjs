// Runs an app's scripted demo headless (design 13): starts a real `weave-relay` process on a free
// port with a fresh data directory, runs `apps/<app>/src/demo.ts` against it, then stops the relay.
//
//   npm run demo:ghostline      npm run demo:fieldnote
//
// The demo receives WEAVE_RELAY_URL and WEAVE_DEMO_DIR, so the app code itself needs no Node.js
// process or file-system imports. Exit code: the demo's.
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const app = process.argv[2];
if (app !== 'ghostline' && app !== 'fieldnote') {
  console.error('usage: node scripts/demo.mjs <ghostline|fieldnote>');
  process.exit(2);
}
const cli = path.join(root, 'packages/relay/dist/cli.js');
if (!existsSync(cli)) {
  console.error('Build first: npm run build');
  process.exit(2);
}

const work = mkdtempSync(path.join(tmpdir(), `weave-demo-${app}-`));
const relay = spawn(process.execPath, [cli], {
  env: { ...process.env, WEAVE_RELAY_DATA: path.join(work, 'relay'), WEAVE_RELAY_PORT: '0' },
  stdio: ['ignore', 'pipe', 'inherit', 'ipc'],
});
const url = await new Promise((resolve, reject) => {
  let out = '';
  relay.stdout.setEncoding('utf8');
  relay.stdout.on('data', (chunk) => {
    out += chunk;
    const m = /listening on (http:\/\/\S+)/.exec(out);
    if (m) resolve(m[1]);
  });
  relay.once('exit', (code) => reject(new Error(`relay exited (${code}): ${out}`)));
});
console.log(`[demo] relay process ${relay.pid} at ${url}`);

const demo = spawn(
  process.execPath,
  ['--import', 'tsx', path.join(root, `apps/${app}/src/demo.ts`)],
  {
    cwd: root,
    env: { ...process.env, WEAVE_RELAY_URL: url, WEAVE_DEMO_DIR: path.join(work, 'devices') },
    stdio: 'inherit',
  },
);
const code = await new Promise((resolve) => demo.once('exit', (c) => resolve(c ?? 1)));

const stopped = new Promise((resolve) => relay.once('exit', resolve));
if (process.platform === 'win32') relay.send('shutdown');
else relay.kill('SIGTERM');
await stopped;
rmSync(work, { recursive: true, force: true });
process.exit(code);

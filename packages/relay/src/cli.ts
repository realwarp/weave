#!/usr/bin/env node
/**
 * weave-relay: start a WEAVE relay over a file data directory (R4a.1).
 *
 *   weave-relay --data ./relay-data --port 8787 [--host 127.0.0.1]
 *
 * Environment: WEAVE_RELAY_DATA, WEAVE_RELAY_PORT, WEAVE_RELAY_HOST, WEAVE_RELAY_TOKEN (optional
 * bearer token; never logged). Binds to 127.0.0.1 by default.
 */
import { startRelay } from './index.js';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const dir = arg('data') ?? process.env['WEAVE_RELAY_DATA'] ?? './relay-data';
const port = Number(arg('port') ?? process.env['WEAVE_RELAY_PORT'] ?? 8787);
const host = arg('host') ?? process.env['WEAVE_RELAY_HOST'] ?? '127.0.0.1';
const token = process.env['WEAVE_RELAY_TOKEN'];

const relay = await startRelay({
  dir,
  port,
  host,
  ...(token === undefined || token === '' ? {} : { token }),
  log: (line) => process.stdout.write(`${line}\n`),
});
process.stdout.write(
  `weave-relay listening on ${relay.url} (data: ${dir}, token: ${token ? 'required' : 'none'})\n`,
);

let stopping = false;
const stop = (): void => {
  if (stopping) return;
  stopping = true;
  void relay.close().then(() => process.exit(0));
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
// Windows cannot deliver SIGTERM to a child: process managers send a 'shutdown' IPC message instead.
process.on('message', (message) => {
  if (message === 'shutdown') stop();
});
if (process.channel !== undefined) process.channel.unref();

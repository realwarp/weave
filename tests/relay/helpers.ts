/** Starts the real `weave-relay` CLI (packages/relay/dist/cli.js) as a child process. */
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createReplica, type Replica } from '@weave/core';
import { memoryStorage } from '@weave/storage/memory';
import { defaultHostId, defaultIsAlive, isReliable } from '@weave/storage/file';
import { runRecoveryProcedure } from '../../packages/storage/test/file/recovery-procedure.js';
import { fakeClock, fakeScheduler, seededRandom } from '../../packages/testing/src/faults/index.js';
import { simNotesV1 } from '../../packages/testing/src/simulator/index.js';

export const CLI = fileURLToPath(new URL('../../packages/relay/dist/cli.js', import.meta.url));

export interface RelayProcess {
  readonly url: string;
  readonly child: ChildProcess;
  readonly output: () => string;
  /** SIGTERM (graceful) or SIGKILL (crash). Resolves when the process has exited. */
  stop(signal?: 'SIGTERM' | 'SIGKILL'): Promise<void>;
}

const temps: string[] = [];
export function tempDir(name: string): string {
  const d = mkdtempSync(join(tmpdir(), `weave-relay-e2e-${name}-`));
  temps.push(d);
  return d;
}
export function cleanTemps(): void {
  for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true });
}

/** Starts the CLI; rejects with its output if it exits before listening. */
export function startRelayProcess(
  dir: string,
  options: { token?: string } = {},
): Promise<RelayProcess> {
  if (!existsSync(CLI)) throw new Error('Build first: packages/relay/dist/cli.js is missing');
  const env: NodeJS.ProcessEnv = { ...process.env, WEAVE_RELAY_DATA: dir, WEAVE_RELAY_PORT: '0' };
  delete env['WEAVE_RELAY_TOKEN'];
  if (options.token !== undefined) env['WEAVE_RELAY_TOKEN'] = options.token;
  const child = spawn(process.execPath, [CLI], { env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  let out = '';
  child.stdout!.setEncoding('utf8');
  child.stderr!.setEncoding('utf8');
  child.stdout!.on('data', (c: string) => (out += c));
  child.stderr!.on('data', (c: string) => (out += c));
  const exited = new Promise<void>((r) => child.once('exit', () => r()));
  return new Promise((resolve, reject) => {
    const onData = () => {
      const m = /listening on (http:\/\/\S+)/.exec(out);
      if (m === null) return;
      child.stdout!.off('data', onData);
      resolve({
        url: m[1]!,
        child,
        output: () => out,
        stop: async (signal = 'SIGTERM') => {
          if (child.exitCode === null && child.signalCode === null) {
            // A graceful stop on Windows goes through the IPC 'shutdown' message (see cli.ts).
            if (signal === 'SIGTERM' && process.platform === 'win32') child.send('shutdown');
            else child.kill(signal);
          }
          await exited;
        },
      });
    };
    child.stdout!.on('data', onData);
    child.once('exit', (code) => reject(new Error(`weave-relay exited (${String(code)}): ${out}`)));
  });
}

/**
 * Restarts a relay after SIGKILL with each platform's expected behavior: Linux with a readable
 * /proc takes the dead lock over; elsewhere the start fails with STORAGE_LOCKED, the documented
 * manual recovery runs, and the next start succeeds.
 */
export async function restartAfterKill(dir: string, options: { token?: string } = {}) {
  if (isReliable(await defaultHostId()))
    return { relay: await startRelayProcess(dir, options), mode: 'takeover' as const };
  const failure = await startRelayProcess(dir, options).then(
    async (r) => {
      await r.stop();
      return 'started';
    },
    (e: unknown) => String(e),
  );
  if (!failure.includes('STORAGE_LOCKED'))
    throw new Error(`expected STORAGE_LOCKED, got: ${failure}`);
  const backupDir = `${dir}-backup-${temps.length}`;
  temps.push(backupDir);
  const outcome = await runRecoveryProcedure(dir, { isAlive: defaultIsAlive, backupDir });
  if (outcome.status !== 'recovered') throw new Error(`recovery stopped: ${outcome.reason}`);
  return { relay: await startRelayProcess(dir, options), mode: 'manual-recovery' as const };
}

let n = 0;
type Collections = Parameters<typeof createReplica>[0]['collections'];

export async function device(
  name: string,
  collections: Collections = [simNotesV1],
  storage = memoryStorage(),
): Promise<Replica> {
  return createReplica({
    storage,
    collections,
    random: seededRandom(`e2e:${name}:${n++}`),
    clock: fakeClock(),
    scheduler: fakeScheduler(),
  });
}

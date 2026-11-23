/**
 * Crash recovery of a REPLICA (not only the storage layer) on the file adapter (task T2.2,
 * R10.4, R15.17). A child process writes records and is killed with SIGKILL (TerminateProcess on
 * Windows). Linux with a readable /proc takes the dead holder's lock over; Windows and macOS refuse
 * with STORAGE_LOCKED until the documented manual recovery is done. Either way the replica must
 * reopen with a whole-write prefix, accept a retry of the interrupted intent, and keep syncing.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { createReplica, isWeaveError } from '@weave/core';
import { readEnvelope } from '@weave/core/protocol';
import { memoryStorage } from '@weave/storage/memory';
import { defaultHostId, defaultIsAlive, fileStorage, isReliable } from '@weave/storage/file';
import { runRecoveryProcedure } from '../../../packages/storage/test/file/recovery-procedure.js';
import { simNotesV1 } from '../../../packages/testing/src/simulator/index.js';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const writer = fileURLToPath(new URL('./fixtures/replica-writer.ts', import.meta.url));
const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

async function killWriter(dir: string): Promise<void> {
  const child = spawn(process.execPath, ['--import', 'tsx', writer, dir], {
    cwd: root,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
  await new Promise<void>((resolve, reject) => {
    let lines = 0;
    child.stdout.on('data', (d: Buffer) => {
      lines += d.toString().split('\n').filter(Boolean).length;
      if (lines >= 4) resolve();
    });
    child.on('exit', (code) =>
      reject(new Error(`writer exited early (${String(code)}): ${stderr}`)),
    );
  });
  const exited = new Promise<void>((r) => child.on('exit', () => r()));
  child.kill('SIGKILL');
  await exited;
  expect(defaultIsAlive(child.pid!)).toBe('dead');
}

/** Opens after a kill with each platform's expected behavior. */
async function reopenAfterKill(
  dir: string,
  backup: string,
): Promise<'takeover' | 'manual-recovery'> {
  if (isReliable(await defaultHostId())) return 'takeover';
  const probe = fileStorage({ dir });
  await expect(probe.open()).rejects.toSatisfy(
    (e: unknown) => isWeaveError(e) && e.code === 'STORAGE_LOCKED',
  );
  const outcome = await runRecoveryProcedure(dir, { isAlive: defaultIsAlive, backupDir: backup });
  expect(outcome.status).toBe('recovered');
  return 'manual-recovery';
}

describe('replica on the file adapter survives SIGKILL (R10.4, R15.17)', () => {
  it(
    'reopens with a whole-write prefix, replays the interrupted intent and keeps syncing',
    { timeout: 120_000 },
    async () => {
      const dir = mkdtempSync(join(tmpdir(), 'weave-kill-'));
      const backup = `${dir}-backup`;
      dirs.push(dir, backup);

      for (let round = 0; round < 3; round++) {
        await killWriter(dir);
        const mode = await reopenAfterKill(dir, `${backup}-${round}`);
        expect(mode).toBe(isReliable(await defaultHostId()) ? 'takeover' : 'manual-recovery');

        const replica = await createReplica({
          storage: fileStorage({ dir }),
          collections: [simNotesV1],
        });
        const status = await replica.status();
        expect(status.pendingBuffer).toBe(0);
        const own = status.vector[replica.id] ?? 0;
        expect(own).toBeGreaterThanOrEqual(15);
        const notes = replica.collection(simNotesV1);
        const records = await notes.query();
        // Whole-write prefix: one op per create, records 0..own-1 in order, none torn.
        expect(records).toHaveLength(own);
        expect(records.map((r) => r.value.n).sort((a, b) => (a ?? 0) - (b ?? 0))).toEqual([
          ...Array(own).keys(),
        ]);

        // Rebuild from the op log gives the same state: the derived state was never ahead or behind.
        const before = await replica.hashes();
        await replica.rebuild();
        expect(await replica.hashes()).toEqual(before);

        // Each written intent replays; the next one (interrupted or never started) writes once.
        const last = await notes.create(
          { title: `note ${own - 1}`, n: own - 1 },
          { mutationId: `m-${own - 1}` },
        );
        expect(last.replayed).toBe(true);
        const next = await notes.create(
          { title: `note ${own}`, n: own },
          { mutationId: `m-${own}` },
        );
        expect(next.replayed).toBe(false);
        expect((await replica.status()).vector[replica.id]).toBe(own + 1);

        // The recovered replica still syncs to an equal state.
        const peer = await createReplica({ storage: memoryStorage(), collections: [simNotesV1] });
        expect((await peer.sync(replica.endpoint())).status).toBe('complete');
        expect(await peer.hashes()).toEqual(await replica.hashes());
        const lines = (
          await replica
            .endpoint()
            .pull({ replicaId: peer.id, vector: {}, support: { notes: 1 }, limit: 10_000 })
        ).ops;
        expect(lines.map((l) => readEnvelope(l).seq)).toEqual(
          [...Array(own + 1).keys()].map((i) => i + 1),
        );
        await peer.close();
        await replica.close();
      }
    },
  );
});

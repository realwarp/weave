/**
 * Forced interleavings for two checks of the guarded open procedure (design 9.1):
 *
 * - Step 2 re-check: an ordinary opener that passed the step-1 guard check, and then created LOCK
 *   after a manual recovery took the guard and removed the stale LOCK, must see the guard right
 *   after its create and back out, so the operator's cleanup is never raced by a new owner.
 * - Step 5 nonce revalidation: when LOCK changes between the observation and the guard, the
 *   recoverer restarts, so the guard it holds while replacing LOCK always names the lock it is
 *   replacing (`observedLockNonce`), which the manual procedure relies on to tell what an
 *   interrupted recoverer meant to replace.
 */
import type * as FsPromises from 'node:fs/promises';
import { readdir, readFile, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GUARD_FILE, LOCK_FILE, fileStorage } from '../../src/file/index.js';
import {
  FakeProcesses,
  UNPROVEN_HOST,
  dataFingerprint,
  expectCode,
  options,
  readAll,
  removeDir,
  tempDir,
} from './helpers.js';
import { runRecoveryProcedure } from './recovery-procedure.js';

interface Hold {
  pid: number;
  reached: () => void;
  release: Promise<void>;
}
const hold: { current: Hold | undefined } = { current: undefined };

vi.mock('node:fs/promises', async (importOriginal) => {
  const real = await importOriginal<typeof FsPromises>();
  const writeFile: typeof real.writeFile = async (file, data, opts) => {
    const h = hold.current;
    const isLockCreate =
      typeof file === 'string' &&
      path.basename(file) === 'LOCK' &&
      typeof opts === 'object' &&
      opts !== null &&
      opts.flag === 'wx' &&
      typeof data === 'string';
    if (h !== undefined && isLockCreate && data.includes(`"pid":${h.pid},`)) {
      hold.current = undefined; // hold back only this opener's first create
      h.reached();
      await h.release;
    }
    return real.writeFile(file, data, opts);
  };
  return { ...real, writeFile, default: { ...real, writeFile } };
});

function gate(): { wait: Promise<void>; open: () => void } {
  let open!: () => void;
  const wait = new Promise<void>((r) => (open = r));
  return { wait, open };
}

describe('file locking: forced interleavings (design 9.1)', () => {
  let dir: string;
  let backup: string;
  let procs: FakeProcesses;
  beforeEach(async () => {
    dir = await tempDir();
    backup = await tempDir();
    await removeDir(backup);
    procs = new FakeProcesses();
  });
  afterEach(async () => {
    hold.current = undefined;
    await removeDir(dir);
    await removeDir(backup);
  });

  const lockFiles = async (): Promise<string[]> =>
    (await readdir(dir)).filter((n) => n.startsWith('LOCK')).sort();

  it('step 2: an opener that creates LOCK during a manual recovery sees the guard and backs out', async () => {
    // A holder with an unproven identity (as on Windows and macOS) dies: manual recovery case.
    const unproven = (pid: number) =>
      options(dir, procs, pid, { hostId: async () => UNPROVEN_HOST });
    const dead = procs.spawn();
    const holder = fileStorage(unproven(dead));
    await holder.open();
    await holder.transaction('rw', async (tx) => tx.put('data/1', 'one'));
    procs.kill(dead);
    const data = await dataFingerprint(dir);

    // B passes its step-1 guard check, and its create of LOCK is held back.
    const bPid = procs.spawn();
    const bReached = gate();
    const bRelease = gate();
    hold.current = { pid: bPid, reached: bReached.open, release: bRelease.wait };
    const bOpen = fileStorage(unproven(bPid)).open();
    await bReached.wait;

    // The operator, following the guide: create the maintenance guard, then remove the stale LOCK.
    const maintenance = JSON.stringify({ maintenance: true });
    await writeFile(path.join(dir, GUARD_FILE), maintenance, { flag: 'wx' });
    await unlink(path.join(dir, LOCK_FILE));

    // B's create now succeeds; the step-2 re-check must make it back out.
    bRelease.open();
    const details = await expectCode(bOpen, 'STORAGE_LOCKED');
    expect(details).toBeDefined();
    expect(await lockFiles()).toEqual([GUARD_FILE]); // B removed its own LOCK
    expect(await readFile(path.join(dir, GUARD_FILE), 'utf8')).toBe(maintenance);
    expect(await dataFingerprint(dir)).toEqual(data);
    for (let i = 0; i < 3; i++)
      await expectCode(fileStorage(unproven(procs.spawn())).open(), 'STORAGE_LOCKED');

    // The operator finishes the procedure (guard removed last); the directory opens again.
    const outcome = await runRecoveryProcedure(dir, { isAlive: procs.probe, backupDir: backup });
    expect(outcome.status).toBe('recovered');
    expect(await lockFiles()).toEqual([]);
    expect(await readAll(unproven(procs.spawn()))).toEqual([['data/1', 'one']]);
  });

  it('step 5: when LOCK changes after the observation, the guard always names the lock replaced', async () => {
    const first = procs.spawn();
    const holder = fileStorage(options(dir, procs, first));
    await holder.open();
    await holder.transaction('rw', async (tx) => tx.put('data/1', 'one'));
    procs.kill(first);
    const stale = JSON.parse(await readFile(path.join(dir, LOCK_FILE), 'utf8')) as Record<
      string,
      unknown
    >;
    // Another dead holder's lock that will appear between R's observation and its guard.
    const second = procs.spawn();
    procs.kill(second);
    const swapped = JSON.stringify({ ...stale, pid: second, nonce: 'n-second' });

    const seen: Array<{ guardObserved: unknown; lockNonce: unknown }> = [];
    let swappedOnce = false;
    const r = fileStorage(
      options(dir, procs, procs.spawn(), {
        failpoint: async (name) => {
          if (name === 'lock:after-observe' && !swappedOnce) {
            swappedOnce = true;
            await writeFile(path.join(dir, LOCK_FILE), swapped);
          }
          if (name === 'lock:after-revalidate') {
            const guard = JSON.parse(await readFile(path.join(dir, GUARD_FILE), 'utf8')) as {
              observedLockNonce: unknown;
            };
            const lock = JSON.parse(await readFile(path.join(dir, LOCK_FILE), 'utf8')) as {
              nonce: unknown;
            };
            seen.push({ guardObserved: guard.observedLockNonce, lockNonce: lock.nonce });
          }
        },
      }),
    );
    await r.open();
    expect(seen).toEqual([{ guardObserved: 'n-second', lockNonce: 'n-second' }]);
    expect(await lockFiles()).toEqual([LOCK_FILE]);
    await r.transaction('rw', async (tx) => tx.put('data/2', 'two'));
    await r.close();
  });
});

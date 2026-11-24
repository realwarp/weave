/**
 * Regression test for the takeover race seen on Windows CI ("openers racing for a dead holder:
 * exactly one wins" observed zero winners). It forces the exact interleaving deterministically:
 *
 * 1. Opener B checks for a guard (none yet) and starts creating LOCK with `wx`; that create is
 *    held back.
 * 2. Opener A observes the stale LOCK, takes the guard, revalidates and replaces the stale lock.
 * 3. B's create is released while A still holds the guard.
 *
 * Before the fix, A moved the stale LOCK aside and then created a new one, so B's create could
 * land in the gap. B then saw A's guard and removed its own LOCK, while A found B's LOCK and gave
 * up: nobody owned the directory. The invariant is exactly one owner and STORAGE_LOCKED for
 * everyone else.
 */
import type * as FsPromises from 'node:fs/promises';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GUARD_FILE, LOCK_FILE, fileStorage } from '../../src/file/index.js';
import { FakeProcesses, expectCode, options, removeDir, tempDir } from './helpers.js';

interface Hold {
  pid: number;
  reached: () => void;
  release: Promise<void>;
  done: () => void;
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
      hold.current = undefined; // hold back only B's first create
      h.reached();
      await h.release;
      try {
        return await real.writeFile(file, data, opts);
      } finally {
        h.done();
      }
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

describe('file locking: takeover race with an ordinary opener (design 9.1)', () => {
  let dir: string;
  let procs: FakeProcesses;
  beforeEach(async () => {
    dir = await tempDir();
    procs = new FakeProcesses();
  });
  afterEach(async () => {
    hold.current = undefined;
    await removeDir(dir);
  });

  it('an ordinary create held back across the takeover still leaves exactly one owner', async () => {
    const dead = procs.spawn();
    const holder = fileStorage(options(dir, procs, dead));
    await holder.open();
    await holder.transaction('rw', async (tx) => tx.put('data/1', 'one'));
    procs.kill(dead);

    const bPid = procs.spawn();
    const bReached = gate();
    const bRelease = gate();
    const bDone = gate();
    hold.current = { pid: bPid, reached: bReached.open, release: bRelease.wait, done: bDone.open };

    const b = fileStorage(options(dir, procs, bPid));
    const bOpen = b.open().then(
      () => 'won' as const,
      (e: unknown) => e,
    );
    await bReached.wait; // B passed its guard check and is about to create LOCK

    const a = fileStorage(
      options(dir, procs, procs.spawn(), {
        failpoint: async (name) => {
          if (name === 'lock:after-rename') {
            bRelease.open(); // let B's create run while A still holds the guard
            await bDone.wait;
          }
        },
      }),
    );
    const aOpen = a.open().then(
      () => 'won' as const,
      (e: unknown) => e,
    );
    const [ra, rb] = await Promise.all([aOpen, bOpen]);

    const winners = [ra, rb].filter((r) => r === 'won');
    expect(winners).toHaveLength(1);
    for (const r of [ra, rb])
      if (r !== 'won') await expectCode(Promise.reject(r), 'STORAGE_LOCKED');

    const files = await readdir(dir);
    expect(files).not.toContain(GUARD_FILE);
    expect(files.filter((n) => n.startsWith('LOCK.'))).toEqual([]);
    const owner = ra === 'won' ? a : b;
    const lock = JSON.parse(await readFile(path.join(dir, LOCK_FILE), 'utf8')) as { pid: number };
    expect(lock.pid).not.toBe(dead);
    await owner.transaction('rw', async (tx) => tx.put('data/2', 'two'));
    await a.close();
    await b.close();
  });
});

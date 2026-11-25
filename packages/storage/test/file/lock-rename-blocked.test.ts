/**
 * Takeover step 6 when the final rename is refused (design 9.1). On Windows, renaming
 * `LOCK.new-*` over `LOCK` fails with EPERM while any other handle has `LOCK` open, for example a
 * racing opener reading it. The takeover must then back out to the state before it started and
 * fail with STORAGE_LOCKED, or, if that cleanup cannot be proven, keep the guard (fail closed)
 * until the manual recovery procedure runs.
 */
import type * as FsPromises from 'node:fs/promises';
import { open, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GUARD_FILE, LOCK_FILE, fileStorage } from '../../src/file/index.js';
import {
  FakeProcesses,
  dataFingerprint,
  expectCode,
  options,
  readAll,
  removeDir,
  tempDir,
} from './helpers.js';
import { runRecoveryProcedure } from './recovery-procedure.js';

/** Test controls: make the step-6 rename, or the pending-file cleanup, fail once. */
const faults: { rename?: string; unlinkPending?: string } = {};

vi.mock('node:fs/promises', async (importOriginal) => {
  const real = await importOriginal<typeof FsPromises>();
  const errno = (code: string): NodeJS.ErrnoException =>
    Object.assign(new Error(`${code}: injected`), { code });
  const isPending = (p: unknown): boolean =>
    typeof p === 'string' && path.basename(p).startsWith('LOCK.new-');
  const rename: typeof real.rename = async (from, to) => {
    if (faults.rename !== undefined && isPending(from)) {
      const code = faults.rename;
      delete faults.rename;
      throw errno(code);
    }
    return real.rename(from, to);
  };
  const unlink: typeof real.unlink = async (p) => {
    if (faults.unlinkPending !== undefined && isPending(p)) {
      const code = faults.unlinkPending;
      delete faults.unlinkPending;
      throw errno(code);
    }
    return real.unlink(p);
  };
  return { ...real, rename, unlink, default: { ...real, rename, unlink } };
});

describe('file locking: refused step-6 rename (design 9.1)', () => {
  let dir: string;
  let backup: string;
  let procs: FakeProcesses;
  let dead: number;
  let staleLock: string;

  beforeEach(async () => {
    dir = await tempDir();
    backup = await tempDir();
    await removeDir(backup);
    procs = new FakeProcesses();
    dead = procs.spawn();
    const holder = fileStorage(options(dir, procs, dead));
    await holder.open();
    await holder.transaction('rw', async (tx) => tx.put('data/1', 'one'));
    procs.kill(dead);
    staleLock = await readFile(path.join(dir, LOCK_FILE), 'utf8');
  });
  afterEach(async () => {
    delete faults.rename;
    delete faults.unlinkPending;
    await removeDir(dir);
    await removeDir(backup);
  });

  const lockFiles = async (): Promise<string[]> =>
    (await readdir(dir)).filter((n) => n.startsWith('LOCK')).sort();

  /** The directory is exactly as before the takeover, and a later takeover succeeds. */
  async function expectBackedOut(): Promise<void> {
    expect(await lockFiles()).toEqual([LOCK_FILE]);
    expect(await readFile(path.join(dir, LOCK_FILE), 'utf8')).toBe(staleLock);
    const next = options(dir, procs, procs.spawn());
    expect(await readAll(next)).toEqual([['data/1', 'one']]);
    expect(await lockFiles()).toEqual([]);
  }

  it('a real Node read handle on LOCK during the rename (Windows: EPERM, typed and backed out)', async () => {
    let reader: Awaited<ReturnType<typeof open>> | undefined;
    const recoverer = fileStorage(
      options(dir, procs, procs.spawn(), {
        failpoint: async (name) => {
          if (name === 'lock:after-new-lock') reader = await open(path.join(dir, LOCK_FILE), 'r');
        },
      }),
    );
    try {
      if (process.platform === 'win32') {
        const details = await expectCode(recoverer.open(), 'STORAGE_LOCKED');
        expect(details).toMatchObject({ cause: 'EPERM', retryable: true });
      } else {
        await recoverer.open(); // POSIX rename(2) replaces a file that is open for reading
        await recoverer.close();
      }
    } finally {
      await reader?.close();
    }
    if (process.platform === 'win32') await expectBackedOut();
  });

  for (const code of ['EPERM', 'EACCES', 'EBUSY']) {
    it(`a ${code} rename backs out to the stale lock and fails with STORAGE_LOCKED`, async () => {
      faults.rename = code;
      const details = await expectCode(
        fileStorage(options(dir, procs, procs.spawn())).open(),
        'STORAGE_LOCKED',
      );
      expect(details).toMatchObject({ cause: code, retryable: true });
      await expectBackedOut();
    });
  }

  it('an unexpected rename error is not swallowed and leaves the guard (fail closed)', async () => {
    faults.rename = 'EIO';
    await expect(fileStorage(options(dir, procs, procs.spawn())).open()).rejects.toMatchObject({
      code: 'EIO',
    });
    expect(await lockFiles()).toContain(GUARD_FILE);
    await expectCode(fileStorage(options(dir, procs, procs.spawn())).open(), 'STORAGE_LOCKED');
  });

  it('if cleanup fails, the guard stays, every open is refused, and manual recovery works', async () => {
    faults.rename = 'EPERM';
    faults.unlinkPending = 'EPERM';
    const recoverer = procs.spawn();
    const details = await expectCode(
      fileStorage(options(dir, procs, recoverer)).open(),
      'STORAGE_LOCKED',
    );
    procs.kill(recoverer); // the guide's step 2 requires every recorded process to be gone
    expect(details).toMatchObject({ cause: 'EPERM', retryable: false, guardLeft: GUARD_FILE });
    const files = await lockFiles();
    expect(files).toHaveLength(3);
    expect(files[0]).toBe(LOCK_FILE);
    expect(files[1]).toMatch(/^LOCK\.new-/);
    expect(files[2]).toBe(GUARD_FILE);
    expect(await readFile(path.join(dir, LOCK_FILE), 'utf8')).toBe(staleLock);
    const data = await dataFingerprint(dir);
    for (let i = 0; i < 3; i++)
      await expectCode(fileStorage(options(dir, procs, procs.spawn())).open(), 'STORAGE_LOCKED');
    expect(await dataFingerprint(dir)).toEqual(data);

    const outcome = await runRecoveryProcedure(dir, { isAlive: procs.probe, backupDir: backup });
    expect(outcome.status).toBe('recovered');
    expect(await lockFiles()).toEqual([]);
    expect(await readAll(options(dir, procs, procs.spawn()))).toEqual([['data/1', 'one']]);
  });
});

/**
 * Takeover step 6 when the final rename of `LOCK.new-*` over `LOCK` fails (design 9.1).
 *
 * - Windows refuses the rename with EPERM, EACCES or EBUSY while any other handle has `LOCK`
 *   open (for example a racing opener reading it). That is transient: back out, STORAGE_LOCKED,
 *   `retryable: true`.
 * - POSIX `rename(2)` is not refused by open handles, so EPERM or EACCES there is a permission
 *   failure (for example a sticky directory and a LOCK owned by another user). That is
 *   permanent: back out, STORAGE_LOCKED, `retryable: false`.
 * - Anything else (EROFS, EIO, EBUSY on POSIX) is not understood: touch nothing, keep the guard,
 *   STORAGE_ERROR with the cause, until the manual recovery procedure runs.
 *
 * If a back-out cannot be proven complete, the guard stays (fail closed).
 * Platform-specific paths are pinned by overriding `process.platform` for one test.
 */
import type * as FsPromises from 'node:fs/promises';
import { open, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GUARD_FILE, LOCK_FILE, fileStorage } from '../../src/file/index.js';
import { classifyRenameFailure } from '../../src/file/lock.js';
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

/**
 * Test controls: make the step-6 rename, or the pending-file cleanup, fail once. `beforeFail`
 * runs just before the injected rename error, to change the directory under the recoverer.
 */
const faults: { rename?: string; unlinkPending?: string; beforeFail?: () => Promise<void> } = {};

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
      const before = faults.beforeFail;
      delete faults.beforeFail;
      await before?.();
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

const realPlatform = process.platform;
function asPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
}

describe('classifyRenameFailure', () => {
  it('Windows sharing errors are in-use, POSIX EPERM/EACCES are permission, the rest unexpected', () => {
    for (const code of ['EPERM', 'EACCES', 'EBUSY'])
      expect(classifyRenameFailure(code, 'win32')).toBe('in-use');
    for (const platform of ['linux', 'darwin'] as const) {
      expect(classifyRenameFailure('EPERM', platform)).toBe('permission');
      expect(classifyRenameFailure('EACCES', platform)).toBe('permission');
      for (const code of ['EBUSY', 'EROFS', 'EIO', undefined])
        expect(classifyRenameFailure(code, platform)).toBe('unexpected');
    }
    for (const code of ['EROFS', 'EIO', undefined])
      expect(classifyRenameFailure(code, 'win32')).toBe('unexpected');
  });
});

describe('file locking: failed step-6 rename (design 9.1)', () => {
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
    asPlatform(realPlatform);
    delete faults.rename;
    delete faults.unlinkPending;
    delete faults.beforeFail;
    await removeDir(dir);
    await removeDir(backup);
  });

  const lockFiles = async (): Promise<string[]> =>
    (await readdir(dir)).filter((n) => n.startsWith('LOCK')).sort();

  /** The directory is exactly as before the takeover (stale LOCK only, same bytes, same data). */
  async function expectUnchanged(data: Record<string, string>): Promise<void> {
    expect(await lockFiles()).toEqual([LOCK_FILE]);
    expect(await readFile(path.join(dir, LOCK_FILE), 'utf8')).toBe(staleLock);
    expect(await dataFingerprint(dir)).toEqual(data);
  }

  /** A later takeover (with no fault) succeeds and the data is intact. */
  async function expectLaterTakeover(): Promise<void> {
    expect(await readAll(options(dir, procs, procs.spawn()))).toEqual([['data/1', 'one']]);
    expect(await lockFiles()).toEqual([]);
  }

  /** The guard, the pending file and the stale LOCK stay; three later opens are refused. */
  async function expectFailClosed(data: Record<string, string>): Promise<void> {
    const files = await lockFiles();
    expect(files).toHaveLength(3);
    expect(files[0]).toBe(LOCK_FILE);
    expect(files[1]).toMatch(/^LOCK\.new-/);
    expect(files[2]).toBe(GUARD_FILE);
    expect(await readFile(path.join(dir, LOCK_FILE), 'utf8')).toBe(staleLock);
    for (let i = 0; i < 3; i++)
      await expectCode(fileStorage(options(dir, procs, procs.spawn())).open(), 'STORAGE_LOCKED');
    expect(await dataFingerprint(dir)).toEqual(data);
  }

  async function expectManualRecovery(recoverer: number): Promise<void> {
    procs.kill(recoverer); // the guide's step 2 requires every recorded process to be gone
    const outcome = await runRecoveryProcedure(dir, { isAlive: procs.probe, backupDir: backup });
    expect(outcome.status).toBe('recovered');
    expect(await lockFiles()).toEqual([]);
    expect(await readAll(options(dir, procs, procs.spawn()))).toEqual([['data/1', 'one']]);
  }

  it('a real Node read handle on LOCK during the rename (Windows: EPERM, typed and backed out)', async () => {
    const data = await dataFingerprint(dir);
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
        expect(details).toMatchObject({ cause: 'EPERM', reason: 'lock-in-use', retryable: true });
      } else {
        await recoverer.open(); // POSIX rename(2) replaces a file that is open for reading
        await recoverer.close();
      }
    } finally {
      await reader?.close();
    }
    if (process.platform === 'win32') {
      await expectUnchanged(data);
      await expectLaterTakeover();
    }
  });

  for (const code of ['EPERM', 'EACCES', 'EBUSY']) {
    it(`Windows: a ${code} rename (LOCK open elsewhere) backs out, retryable`, async () => {
      asPlatform('win32');
      const data = await dataFingerprint(dir);
      faults.rename = code;
      const error = fileStorage(options(dir, procs, procs.spawn())).open();
      const details = await expectCode(error, 'STORAGE_LOCKED');
      expect(details).toMatchObject({ cause: code, reason: 'lock-in-use', retryable: true });
      await expectUnchanged(data);
      await expectLaterTakeover();
    });
  }

  for (const code of ['EPERM', 'EACCES']) {
    it(`Linux: a ${code} rename is a permission failure: backed out, not retryable`, async () => {
      asPlatform('linux');
      const data = await dataFingerprint(dir);
      for (let attempt = 0; attempt < 2; attempt++) {
        faults.rename = code; // permanent: the same opener fails the same way every time
        const details = await expectCode(
          fileStorage(options(dir, procs, procs.spawn())).open(),
          'STORAGE_LOCKED',
        );
        expect(details).toMatchObject({
          cause: code,
          reason: 'permission-denied',
          retryable: false,
        });
        expect(details).not.toHaveProperty('guardLeft');
        await expectUnchanged(data);
      }
      await expectLaterTakeover(); // once permissions allow it, the takeover works
    });
  }

  for (const [platform, code] of [
    ['linux', 'EROFS'],
    ['linux', 'EBUSY'],
    ['win32', 'EROFS'],
    ['linux', 'EIO'],
  ] as const) {
    it(`${platform}: an unexpected ${code} rename keeps the guard and fails with STORAGE_ERROR`, async () => {
      asPlatform(platform);
      const data = await dataFingerprint(dir);
      faults.rename = code;
      const recoverer = procs.spawn();
      const failure = fileStorage(options(dir, procs, recoverer))
        .open()
        .then(
          () => undefined,
          (e: unknown) =>
            e as { code?: string; details?: Record<string, unknown>; cause?: unknown },
        );
      const err = await failure;
      expect(err?.code).toBe('STORAGE_ERROR');
      expect(err?.details).toMatchObject({
        cause: code,
        reason: 'rename-failed',
        retryable: false,
        guardLeft: GUARD_FILE,
      });
      expect((err?.cause as { code?: string } | undefined)?.code).toBe(code);
      await expectFailClosed(data);
      await expectManualRecovery(recoverer);
    });
  }

  it('if LOCK is no longer the stale lock after a refused rename, the guard stays', async () => {
    asPlatform('win32');
    const foreign = JSON.stringify({ ...JSON.parse(staleLock), nonce: 'someone-else' });
    faults.rename = 'EPERM';
    faults.beforeFail = () => writeFile(path.join(dir, LOCK_FILE), foreign);
    const details = await expectCode(
      fileStorage(options(dir, procs, procs.spawn())).open(),
      'STORAGE_LOCKED',
    );
    expect(details).toMatchObject({
      cause: 'EPERM',
      reason: 'cleanup-incomplete',
      retryable: false,
    });
    expect(await lockFiles()).toEqual([LOCK_FILE, GUARD_FILE]);
    expect(await readFile(path.join(dir, LOCK_FILE), 'utf8')).toBe(foreign);
    await expectCode(fileStorage(options(dir, procs, procs.spawn())).open(), 'STORAGE_LOCKED');
  });

  it('if the guard is no longer ours after a refused rename, it is not removed', async () => {
    asPlatform('linux');
    const other = JSON.stringify({ recoveryNonce: 'other', observedLockNonce: 'x', pid: 1 });
    faults.rename = 'EACCES';
    faults.beforeFail = () => writeFile(path.join(dir, GUARD_FILE), other);
    const details = await expectCode(
      fileStorage(options(dir, procs, procs.spawn())).open(),
      'STORAGE_LOCKED',
    );
    expect(details).toMatchObject({
      cause: 'EACCES',
      reason: 'cleanup-incomplete',
      retryable: false,
    });
    expect(await readFile(path.join(dir, GUARD_FILE), 'utf8')).toBe(other);
    expect(await readFile(path.join(dir, LOCK_FILE), 'utf8')).toBe(staleLock);
  });

  for (const [platform, code] of [
    ['win32', 'EPERM'],
    ['linux', 'EACCES'],
  ] as const) {
    it(`${platform}: if back-out cleanup fails after ${code}, the guard stays and manual recovery works`, async () => {
      asPlatform(platform);
      const data = await dataFingerprint(dir);
      faults.rename = code;
      faults.unlinkPending = 'EPERM';
      const recoverer = procs.spawn();
      const details = await expectCode(
        fileStorage(options(dir, procs, recoverer)).open(),
        'STORAGE_LOCKED',
      );
      expect(details).toMatchObject({
        cause: code,
        reason: 'cleanup-incomplete',
        retryable: false,
        guardLeft: GUARD_FILE,
      });
      await expectFailClosed(data);
      await expectManualRecovery(recoverer);
    });
  }
});

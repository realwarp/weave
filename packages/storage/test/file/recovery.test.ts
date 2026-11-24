import { readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GUARD_FILE, fileStorage, type FileStorageOptions } from '../../src/file/index.js';
import {
  FakeProcesses,
  UNPROVEN_HOST,
  dataFingerprint,
  expectCode,
  options,
  readAll,
  removeDir,
  sleep,
  tempDir,
} from './helpers.js';
import { runRecoveryProcedure } from './recovery-procedure.js';

/**
 * These tests use an UNPROVEN host identity (like Windows and macOS), so a dead holder's lock can
 * never be taken over automatically and the manual procedure is the only way back.
 */
describe('manual offline recovery (design 9.1, R15.20)', () => {
  let dir: string;
  let backup: string;
  let procs: FakeProcesses;
  const unproven = (pid: number, extra: Partial<FileStorageOptions> = {}) =>
    options(dir, procs, pid, { hostId: async () => UNPROVEN_HOST, ...extra });

  beforeEach(async () => {
    dir = await tempDir();
    backup = await tempDir();
    await removeDir(backup);
    procs = new FakeProcesses();
  });
  afterEach(async () => {
    await removeDir(dir);
    await removeDir(backup);
  });

  /** A holder writes data and dies without releasing LOCK. */
  async function deadHolder(): Promise<void> {
    const pid = procs.spawn();
    const s = fileStorage(unproven(pid));
    await s.open();
    for (let i = 0; i < 3; i++)
      await s.transaction('rw', async (tx) => tx.put(`data/${i}`, `v${i}`));
    procs.kill(pid);
  }

  /** A recoverer with a RELIABLE identity... cannot exist here, so build guard states directly. */
  async function guardState(
    kind: 'guard+old-lock' | 'guard+new-lock' | 'guard-only' | 'stale+guard',
  ): Promise<void> {
    const lock = JSON.parse(await readFile(path.join(dir, 'LOCK'), 'utf8')) as Record<
      string,
      unknown
    >;
    const recoverer = procs.spawn();
    procs.kill(recoverer);
    const guard = JSON.stringify({
      recoveryNonce: 'r1',
      observedLockNonce: lock['nonce'],
      pid: recoverer,
      hostId: UNPROVEN_HOST,
    });
    await writeFile(path.join(dir, GUARD_FILE), guard);
    const { unlink, rename } = await import('node:fs/promises');
    if (kind === 'guard+new-lock') {
      await rename(path.join(dir, 'LOCK'), path.join(dir, 'LOCK.stale-r1'));
      await writeFile(
        path.join(dir, 'LOCK'),
        JSON.stringify({ ...lock, nonce: 'new', pid: recoverer }),
      );
    }
    if (kind === 'guard-only') await unlink(path.join(dir, 'LOCK'));
    if (kind === 'stale+guard')
      await rename(path.join(dir, 'LOCK'), path.join(dir, 'LOCK.stale-r1'));
  }

  const combos = [
    'lock-only',
    'guard+old-lock',
    'guard+new-lock',
    'guard-only',
    'stale+guard',
  ] as const;

  for (const combo of combos) {
    it(`recovers the combination "${combo}" by following the guide literally`, async () => {
      await deadHolder();
      if (combo !== 'lock-only') await guardState(combo);
      const before = await dataFingerprint(dir);
      await expectCode(fileStorage(unproven(procs.spawn())).open(), 'STORAGE_LOCKED');
      expect(await dataFingerprint(dir)).toEqual(before);

      const outcome = await runRecoveryProcedure(dir, { isAlive: procs.probe, backupDir: backup });
      expect(outcome.status).toBe('recovered');
      const left = (await readdir(dir)).filter((n) => n.startsWith('LOCK'));
      expect(left).toEqual([]);
      const reopened = unproven(procs.spawn());
      expect((await readAll(reopened)).map((e) => e[0])).toEqual(['data/0', 'data/1', 'data/2']);
      const s = fileStorage(reopened);
      await s.open();
      await s.transaction('rw', async (tx) => tx.put('after', 'recovery'));
      await s.close();
      // the backup is untouched by the reopen
      expect(await readdir(backup)).toContain('MANIFEST');
    });
  }

  it('a stray LOCK.stale-* file alone does not block opening, and the guide removes it', async () => {
    await writeFile(path.join(dir, 'LOCK.stale-old'), '{}');
    expect(await readAll(unproven(procs.spawn()))).toEqual([]);
    const outcome = await runRecoveryProcedure(dir, { isAlive: procs.probe, backupDir: backup });
    expect(outcome).toMatchObject({
      status: 'recovered',
      removed: ['LOCK.stale-old', 'LOCK.recovery'],
    });
  });

  it('removing only LOCK while a guard is present still leaves the directory refused', async () => {
    await deadHolder();
    await guardState('guard+old-lock');
    const { unlink } = await import('node:fs/promises');
    await unlink(path.join(dir, 'LOCK'));
    await expectCode(fileStorage(unproven(procs.spawn())).open(), 'STORAGE_LOCKED');
  });

  it('step 2 stops when a PID named in LOCK is alive', async () => {
    const pid = procs.spawn();
    const live = fileStorage(unproven(pid));
    await live.open();
    const outcome = await runRecoveryProcedure(dir, { isAlive: procs.probe, backupDir: backup });
    expect(outcome.status).toBe('stopped');
    await live.transaction('rw', async (tx) => tx.put('still', 'mine'));
    await live.close();
  });

  for (const combo of ['lock-only', 'stale+guard', 'guard-only'] as const) {
    it(`ordinary openers are refused throughout cleanup of "${combo}" and exactly one wins afterwards`, async () => {
      await deadHolder();
      if (combo !== 'lock-only') await guardState(combo);
      let guardRemoved = false;
      let stop = false;
      const earlyWins: string[] = [];
      const winners: number[] = [];
      const racer = async (id: number): Promise<void> => {
        while (!stop) {
          const s = fileStorage(unproven(procs.spawn()));
          try {
            await s.open();
            if (!guardRemoved) earlyWins.push(`opener ${id}`);
            winners.push(id);
            return; // keep the lock
          } catch (e) {
            expect((e as { code: string }).code).toBe('STORAGE_LOCKED');
          }
          await sleep(1);
        }
      };
      const racers = [0, 1, 2, 3].map(racer);
      const outcome = await runRecoveryProcedure(dir, {
        isAlive: procs.probe,
        backupDir: backup,
        between: async (step) => {
          await sleep(5 + (step.length % 4));
          if (step === 'after-lock-removed') await sleep(20);
        },
      });
      guardRemoved = true;
      expect(outcome.status).toBe('recovered');
      await sleep(80);
      stop = true;
      await Promise.all(racers);
      expect(earlyWins).toEqual([]);
      expect(winners).toHaveLength(1);
    });
  }

  it('control: removing the guard FIRST lets an opener in, and the procedure then deletes a live lock', async () => {
    await deadHolder();
    await guardState('stale+guard'); // the dangerous state: guard present, LOCK absent
    const opener = fileStorage(unproven(procs.spawn()));
    let opened = false;
    const outcome = await runRecoveryProcedure(dir, {
      isAlive: procs.probe,
      backupDir: backup,
      unsafeReverseOrder: true,
      between: async (step) => {
        if (step === 'after-guard-removed-early') {
          await opener.open(); // an ordinary opener acquires LOCK mid-cleanup
          opened = true;
        }
      },
    });
    expect(outcome.status).toBe('recovered');
    expect(opened).toBe(true);
    // The unsafe order deleted the live owner's LOCK: it now fails closed.
    await expectCode(
      opener.transaction('rw', async (tx) => tx.put('x', 'y')),
      'STORAGE_LOCK_LOST',
    );
  });
});

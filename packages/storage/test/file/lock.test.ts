import { appendFile, readFile, readdir, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { encodeRecord } from '../../src/file/format.js';
import {
  GUARD_FILE,
  LOCK_FILE,
  defaultHostId,
  fileStorage,
  isReliable,
  type FileStorageOptions,
  type HostId,
} from '../../src/file/index.js';
import {
  FakeProcesses,
  RELIABLE_HOST,
  UNPROVEN_HOST,
  dataFingerprint,
  expectCode,
  options,
  readAll,
  removeDir,
  tempDir,
} from './helpers.js';

const lockPath = (dir: string) => path.join(dir, LOCK_FILE);
const readLock = async (dir: string) =>
  JSON.parse(await readFile(lockPath(dir), 'utf8')) as { pid: number; nonce: string };

/** Opens an adapter as pid and then "kills" the process without closing (LOCK stays). */
async function crashHolder(
  dir: string,
  procs: FakeProcesses,
  extra: Partial<FileStorageOptions> = {},
): Promise<number> {
  const pid = procs.spawn();
  const s = fileStorage(options(dir, procs, pid, extra));
  await s.open();
  await s.transaction('rw', async (tx) => tx.put('data/1', 'one'));
  procs.kill(pid);
  return pid;
}

function gate(): { wait: Promise<void>; open: () => void } {
  let open!: () => void;
  const wait = new Promise<void>((r) => (open = r));
  return { wait, open };
}

describe('file locking (design 9.1)', () => {
  let dir: string;
  let procs: FakeProcesses;
  beforeEach(async () => {
    dir = await tempDir();
    procs = new FakeProcesses();
  });
  afterEach(() => removeDir(dir));

  it('a live holder is refused, whatever the age of its lock', async () => {
    const holder = fileStorage(options(dir, procs, procs.spawn()));
    await holder.open();
    const lock = JSON.parse(await readFile(lockPath(dir), 'utf8')) as Record<string, unknown>;
    await writeFile(lockPath(dir), JSON.stringify({ ...lock, startedAt: 0 }));
    await expectCode(fileStorage(options(dir, procs, procs.spawn())).open(), 'STORAGE_LOCKED');
    await holder.close();
  });

  it('the real current process is seen as alive by the default probe', async () => {
    const holder = fileStorage({ dir, pid: process.pid, hostId: async () => RELIABLE_HOST });
    await holder.open();
    await expectCode(
      fileStorage({ dir, hostId: async () => RELIABLE_HOST }).open(),
      'STORAGE_LOCKED',
    );
    await holder.close();
  });

  it('a dead holder on the same reliable host is taken over', async () => {
    await crashHolder(dir, procs);
    const next = options(dir, procs, procs.spawn());
    expect(await readAll(next)).toEqual([['data/1', 'one']]);
    expect(await readdir(dir)).not.toContain(GUARD_FILE);
  });

  it('a different host, boot or PID namespace is refused even when the PID is dead', async () => {
    await crashHolder(dir, procs);
    for (const other of [
      { ...RELIABLE_HOST, hostname: 'elsewhere' },
      { ...RELIABLE_HOST, bootId: 'boot-2' },
      { ...RELIABLE_HOST, pidNamespace: 'pid:[2]' },
    ] satisfies HostId[]) {
      await expectCode(
        fileStorage(options(dir, procs, procs.spawn(), { hostId: async () => other })).open(),
        'STORAGE_LOCKED',
      );
    }
  });

  it('an unproven identity (either side) is refused even when the PID is dead', async () => {
    await crashHolder(dir, procs, { hostId: async () => UNPROVEN_HOST });
    await expectCode(fileStorage(options(dir, procs, procs.spawn())).open(), 'STORAGE_LOCKED');
    await expectCode(
      fileStorage(options(dir, procs, procs.spawn(), { hostId: async () => UNPROVEN_HOST })).open(),
      'STORAGE_LOCKED',
    );
  });

  it('the default identity is reliable only on Linux with /proc (this platform decides takeover)', async () => {
    const id = await defaultHostId();
    if (process.platform === 'linux') expect(typeof id.hostname).toBe('string');
    else expect(isReliable(id)).toBe(false);
  });

  it('openers racing for a dead holder: exactly one wins', async () => {
    await crashHolder(dir, procs);
    const openers = Array.from({ length: 8 }, () =>
      fileStorage(options(dir, procs, procs.spawn())),
    );
    const results = await Promise.allSettled(openers.map((o) => o.open()));
    const wins = results.filter((r) => r.status === 'fulfilled');
    expect(wins).toHaveLength(1);
    for (const r of results)
      if (r.status === 'rejected')
        expect((r.reason as { code: string }).code).toBe('STORAGE_LOCKED');
    await Promise.all(openers.map((o) => o.close()));
  });

  it('the reviewed interleaving: B observes the stale lock, A takes over, B fails and A is untouched', async () => {
    await crashHolder(dir, procs);
    const bObserved = gate();
    const bResume = gate();
    const b = fileStorage(
      options(dir, procs, procs.spawn(), {
        failpoint: async (name) => {
          if (name === 'lock:after-observe') {
            bObserved.open();
            await bResume.wait;
          }
        },
      }),
    );
    const bOpen = b.open();
    await bObserved.wait;
    const a = fileStorage(options(dir, procs, procs.spawn()));
    await a.open();
    await a.transaction('rw', async (tx) => tx.put('a', 'writes'));
    const aLock = await readLock(dir);
    const before = await dataFingerprint(dir);
    bResume.open();
    await expectCode(bOpen, 'STORAGE_LOCKED');
    expect(await readLock(dir)).toEqual(aLock);
    expect(await dataFingerprint(dir)).toEqual(before);
    expect(await readdir(dir)).not.toContain(GUARD_FILE);
    await a.transaction('rw', async (tx) => tx.put('a', 'still owner'));
    await a.close();
  });

  for (const point of [
    'lock:after-guard-create',
    'lock:after-revalidate',
    'lock:after-rename',
    'lock:after-new-lock',
  ]) {
    it(`a recoverer killed at ${point} leaves a guard, and every later open is refused`, async () => {
      await crashHolder(dir, procs);
      const recoverer = procs.spawn();
      await expect(
        fileStorage(
          options(dir, procs, recoverer, {
            failpoint: (name) => {
              if (name === point) throw new Error('killed');
            },
          }),
        ).open(),
      ).rejects.toThrow('killed');
      procs.kill(recoverer);
      expect(await readdir(dir)).toContain(GUARD_FILE);
      for (let i = 0; i < 3; i++)
        await expectCode(fileStorage(options(dir, procs, procs.spawn())).open(), 'STORAGE_LOCKED');
    });
  }

  it('random interleavings of many openers never produce two owners', async () => {
    for (let round = 0; round < 10; round++) {
      await crashHolder(dir, procs);
      let owners = 0;
      let maxOwners = 0;
      const delay = (seed: number) =>
        new Promise<void>((r) => setTimeout(r, (seed * 7 + round * 3) % 5));
      const openers = Array.from({ length: 6 }, (_, i) =>
        fileStorage(options(dir, procs, procs.spawn(), { failpoint: () => delay(i) })),
      );
      const opened = await Promise.allSettled(
        openers.map(async (o) => {
          await o.open();
          owners++;
          maxOwners = Math.max(maxOwners, owners);
        }),
      );
      expect(maxOwners).toBe(1);
      expect(opened.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      await Promise.all(openers.map((o) => o.close()));
      await unlink(lockPath(dir)).catch(() => undefined);
    }
  });

  it('a holder whose LOCK was removed or replaced fails closed with STORAGE_LOCK_LOST', async () => {
    const holder = fileStorage(options(dir, procs, procs.spawn()));
    await holder.open();
    await unlink(lockPath(dir));
    await expectCode(
      holder.transaction('rw', async (tx) => tx.put('x', '1')),
      'STORAGE_LOCK_LOST',
    );
    await writeFile(
      lockPath(dir),
      JSON.stringify({ pid: 1, nonce: 'someone-else', hostId: RELIABLE_HOST }),
    );
    await expectCode(
      holder.transaction('rw', async (tx) => tx.put('x', '1')),
      'STORAGE_LOCK_LOST',
    );
    expect(await holder.transaction('ro', (tx) => tx.get('x'))).toBeUndefined();
  });

  it('a rogue append with a stale epoch is detected at the next open', async () => {
    const a = fileStorage(options(dir, procs, procs.spawn()));
    await a.open();
    await a.transaction('rw', async (tx) => tx.put('a', '1')); // epoch 1, txId 1
    await unlink(lockPath(dir)); // someone deleted LOCK by hand while A runs
    const b = fileStorage(options(dir, procs, procs.spawn()));
    await b.open(); // epoch 2
    await b.transaction('rw', async (tx) => tx.put('b', '1')); // txId 2
    await expectCode(
      a.transaction('rw', async (tx) => tx.put('a', '2')),
      'STORAGE_LOCK_LOST',
    );
    await b.close();
    // A forces its write anyway (the check-then-append window): epoch 1 after epoch 2
    await appendFile(
      path.join(dir, 'journal-1.log'),
      encodeRecord({ generation: 1, epoch: 1, txId: 3 }, [['a', '2']]),
    );
    await expectCode(fileStorage(options(dir, procs, procs.spawn())).open(), 'STORAGE_CORRUPT');
  });

  it('offers no lock override option anywhere', async () => {
    const src = path.resolve(__dirname, '../../src');
    const files = await readdir(path.join(src, 'file'));
    for (const f of files) {
      const text = await readFile(path.join(src, 'file', f), 'utf8');
      expect(text).not.toMatch(/break-?lock|forceUnlock|force-unlock|stealLock/i);
    }
  });
});

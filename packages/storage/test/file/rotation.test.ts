import { copyFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ROTATION_FAILPOINTS, fileStorage, type FileStorageOptions } from '../../src/file/index.js';
import { FakeProcesses, expectCode, options, readAll, removeDir, tempDir } from './helpers.js';

describe('file journal: snapshot rotation (design 9.1)', () => {
  let dir: string;
  let procs: FakeProcesses;
  beforeEach(async () => {
    dir = await tempDir();
    procs = new FakeProcesses();
  });
  afterEach(() => removeDir(dir));

  it('rotates into a new generation and keeps every transaction', async () => {
    const opts = options(dir, procs, procs.spawn(), { rotateBytes: 400 });
    const s = fileStorage(opts);
    await s.open();
    for (let i = 0; i < 40; i++)
      await s.transaction('rw', async (tx) => tx.put(`k/${String(i).padStart(3, '0')}`, `v${i}`));
    await s.close();
    const names = await readdir(dir);
    const generations = names.filter((n) => /^journal-\d+\.log$/.test(n));
    expect(generations).toHaveLength(1);
    expect(generations[0]).not.toBe('journal-1.log');
    expect(await readAll(opts)).toHaveLength(40);
  });

  for (const point of ROTATION_FAILPOINTS) {
    it(`a crash at ${point} loses nothing that was committed`, async () => {
      const crashedPid = procs.spawn();
      let armed = false;
      const crashing: FileStorageOptions = options(dir, procs, crashedPid, {
        rotateBytes: 300,
        failpoint: (name) => {
          if (armed && name === point) throw new Error(`simulated crash at ${point}`);
        },
      });
      const s = fileStorage(crashing);
      await s.open();
      const committed: string[] = [];
      let inFlight: string | undefined;
      for (let i = 0; i < 60; i++) {
        const key = `k/${String(i).padStart(3, '0')}`;
        if (i === 5) armed = true;
        try {
          await s.transaction('rw', async (tx) => tx.put(key, `v${i}`));
          committed.push(key);
        } catch {
          inFlight = key; // its record was appended and fsynced before rotation started
          break;
        }
      }
      expect(inFlight).toBeDefined();
      // the dead adapter refuses further use, like a killed process
      await expectCode(
        s.transaction('ro', (tx) => tx.get('x')),
        'STORAGE_ERROR',
      );
      procs.kill(crashedPid);
      const reopened = options(dir, procs, procs.spawn(), { rotateBytes: 300 });
      const keys = (await readAll(reopened)).map((e) => e[0]);
      expect(keys).toEqual([...committed, inFlight!]);
      // and it keeps working
      const again = fileStorage(reopened);
      await again.open();
      await again.transaction('rw', async (tx) => tx.put('after', 'crash'));
      await again.close();
      expect(await readAll(reopened)).toHaveLength(committed.length + 2);
      const leftovers = (await readdir(dir)).filter((n) => n.endsWith('.tmp'));
      expect(leftovers).toEqual([]);
    });
  }

  it('an old journal beside a newer snapshot is ignored and removed', async () => {
    const opts = options(dir, procs, procs.spawn(), { rotateBytes: 300 });
    const s = fileStorage({ ...opts, rotateBytes: 1_000_000 });
    await s.open();
    for (let i = 0; i < 5; i++) await s.transaction('rw', async (tx) => tx.put(`old/${i}`, 'x'));
    await s.close();
    await copyFile(path.join(dir, 'journal-1.log'), path.join(dir, 'saved-journal'));
    const r = fileStorage(opts);
    await r.open();
    for (let i = 0; i < 20; i++)
      await r.transaction('rw', async (tx) => tx.put(`new/${String(i).padStart(2, '0')}`, 'y'));
    await r.transaction('rw', async (tx) => tx.delete('old/0'));
    await r.close();
    expect(await readdir(dir)).not.toContain('journal-1.log');
    await copyFile(path.join(dir, 'saved-journal'), path.join(dir, 'journal-1.log'));
    await writeFile(path.join(dir, 'snap-1.json'), '{"stale":true}');
    const keys = (await readAll(opts)).map((e) => e[0]);
    expect(keys).not.toContain('old/0');
    expect(keys.filter((k) => k.startsWith('new/'))).toHaveLength(20);
    const names = await readdir(dir);
    expect(names).not.toContain('journal-1.log');
    expect(names).not.toContain('snap-1.json');
  });
});

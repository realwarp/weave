import { appendFile, readFile, truncate, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runStorageConformance } from '../../../testing/src/storage/index.js';
import { encodeRecord } from '../../src/file/format.js';
import { fileStorage, type FileStorageOptions } from '../../src/file/index.js';
import {
  FakeProcesses,
  dataFingerprint,
  expectCode,
  options,
  readAll,
  recordBounds,
  removeDir,
  tempDir,
  writeTransactions,
} from './helpers.js';

runStorageConformance('file', async () => {
  const dir = await tempDir();
  const procs = new FakeProcesses();
  const pid = procs.spawn();
  return {
    adapter: fileStorage(options(dir, procs, pid)),
    reopen: async () => fileStorage(options(dir, procs, pid)),
    cleanup: () => removeDir(dir),
  };
});

runStorageConformance('file with constant rotation', async () => {
  const dir = await tempDir();
  const procs = new FakeProcesses();
  const pid = procs.spawn();
  return {
    adapter: fileStorage(options(dir, procs, pid, { rotateBytes: 1 })),
    reopen: async () => fileStorage(options(dir, procs, pid, { rotateBytes: 1 })),
    cleanup: () => removeDir(dir),
  };
});

describe('file journal: damage handling (design 9.1, R15.17)', () => {
  let dir: string;
  let opts: FileStorageOptions;
  const N = 5;
  const journal = (): string => path.join(dir, 'journal-1.log');
  const keys = (n: number) =>
    Array.from({ length: n }, (_, i) => `k/${String(i).padStart(4, '0')}`);

  beforeEach(async () => {
    dir = await tempDir();
    const procs = new FakeProcesses();
    opts = options(dir, procs, procs.spawn());
    await writeTransactions(opts, N);
  });
  afterEach(() => removeDir(dir));

  async function expectCorruptUnchanged(kind: string): Promise<Record<string, unknown>> {
    const before = await dataFingerprint(dir);
    const details = await expectCode(fileStorage(opts).open(), 'STORAGE_CORRUPT');
    expect(details['kind']).toBe(kind);
    expect(await dataFingerprint(dir)).toEqual(before);
    // the lock was released: a healthy open is possible after repair
    return details;
  }

  it('a clean journal reopens with every transaction', async () => {
    expect((await readAll(opts)).map((e) => e[0])).toEqual(keys(N));
  });

  it('cut inside the header of the final record (1..31 bytes) fails closed; truncation only by the operator', async () => {
    const buf = await readFile(journal());
    const last = recordBounds(buf).at(-1)!;
    for (let cut = 1; cut < 32; cut++) {
      await writeFile(journal(), buf.subarray(0, last.start + cut));
      const details = await expectCorruptUnchanged('partial-header');
      expect(details['validEndOffset']).toBe(last.start);
      expect(details['truncatable']).toBe(true);
      await expectCode(
        fileStorage({ ...opts, onCorruptTail: { truncateAt: last.start + 1 } }).open(),
        'STORAGE_CORRUPT',
      );
    }
    const repaired = { ...opts, onCorruptTail: { truncateAt: last.start } };
    expect((await readAll(repaired)).map((e) => e[0])).toEqual(keys(N - 1));
    expect((await readFile(journal())).length).toBe(last.start);
  });

  it('cut after a verified header (32..len-1 bytes) is an incomplete append and is truncated automatically', async () => {
    const buf = await readFile(journal());
    const last = recordBounds(buf).at(-1)!;
    for (let cut = 32; cut < last.length; cut++) {
      await writeFile(journal(), buf.subarray(0, last.start + cut));
      const events: number[] = [];
      expect(
        (await readAll({ ...opts, onEvent: (e) => events.push(e.bytes) })).map((e) => e[0]),
      ).toEqual(keys(N - 1));
      expect(events).toEqual([cut]);
      expect((await readFile(journal())).length).toBe(last.start);
    }
  });

  it('a complete final record with a corrupted length field fails closed and truncates nothing', async () => {
    const buf = await readFile(journal());
    const last = recordBounds(buf).at(-1)!;
    const len = buf.readUInt32BE(last.start + 20);
    for (const value of [len + 1, len + 1_000_000, len - 1, 0, 0xffffffff]) {
      const damaged = Buffer.from(buf);
      damaged.writeUInt32BE(value, last.start + 20);
      await writeFile(journal(), damaged);
      const details = await expectCorruptUnchanged('header');
      expect(details['truncatable']).toBe(false);
      await expectCode(
        fileStorage({ ...opts, onCorruptTail: { truncateAt: last.start } }).open(),
        'STORAGE_CORRUPT',
      );
    }
  });

  it('flips in any part of the final record fail closed', async () => {
    const buf = await readFile(journal());
    const last = recordBounds(buf).at(-1)!;
    const spots: Array<[string, number, string]> = [
      ['magic', 0, 'header'],
      ['generation', 5, 'header'],
      ['epoch', 9, 'header'],
      ['txId', 17, 'header'],
      ['headerCheck', 27, 'header'],
      ['payload', 33, 'payload'],
      ['trailer', last.length - 3, 'payload'],
    ];
    for (const [, at, kind] of spots) {
      const damaged = Buffer.from(buf);
      damaged[last.start + at]! ^= 0x01;
      await writeFile(journal(), damaged);
      await expectCorruptUnchanged(kind);
    }
  });

  it('a payload-damaged LAST record can be removed only by the explicit operator option at the reported offset', async () => {
    const buf = await readFile(journal());
    const last = recordBounds(buf).at(-1)!;
    const damaged = Buffer.from(buf);
    damaged[last.start + 40]! ^= 0xff;
    await writeFile(journal(), damaged);
    const details = await expectCorruptUnchanged('payload');
    expect(details).toMatchObject({ truncatable: true, validEndOffset: last.start });
    await expectCode(
      fileStorage({ ...opts, onCorruptTail: { truncateAt: last.start - 1 } }).open(),
      'STORAGE_CORRUPT',
    );
    expect(
      (await readAll({ ...opts, onCorruptTail: { truncateAt: last.start } })).map((e) => e[0]),
    ).toEqual(keys(N - 1));
  });

  it('damage in a middle record always fails closed, and operator truncation is refused', async () => {
    const buf = await readFile(journal());
    const mid = recordBounds(buf)[2]!;
    for (const at of [0, 21, 40, mid.length - 1]) {
      const damaged = Buffer.from(buf);
      damaged[mid.start + at]! ^= 0x10;
      await writeFile(journal(), damaged);
      const details = await expectCode(fileStorage(opts).open(), 'STORAGE_CORRUPT');
      expect(details['truncatable']).toBe(false);
      await expectCode(
        fileStorage({ ...opts, onCorruptTail: { truncateAt: mid.start } }).open(),
        'STORAGE_CORRUPT',
      );
    }
  });

  it('a zero-filled tail fails closed (header) or as a partial header', async () => {
    const buf = await readFile(journal());
    await writeFile(journal(), Buffer.concat([buf, Buffer.alloc(200)]));
    await expectCorruptUnchanged('header');
    await writeFile(journal(), Buffer.concat([buf, Buffer.alloc(10)]));
    await expectCorruptUnchanged('partial-header');
  });

  it('a lower epoch after a higher one, or a repeated txId, is STORAGE_CORRUPT', async () => {
    await writeTransactions(opts, 1, N); // second open: higher epoch, txId N+1
    const buf = await readFile(journal());
    await appendFile(
      journal(),
      encodeRecord({ generation: 1, epoch: 1, txId: N + 2 }, [['rogue', 'x']]),
    );
    expect((await expectCorruptUnchanged('sequence'))['reason']).toMatch(/epoch/);
    await writeFile(journal(), buf);
    await appendFile(
      journal(),
      encodeRecord({ generation: 1, epoch: 2, txId: N + 1 }, [['dup', 'x']]),
    );
    expect((await expectCorruptUnchanged('sequence'))['reason']).toMatch(/txId/);
  });

  it('a bad snapshot or a bad MANIFEST fails closed and changes nothing', async () => {
    await writeFile(path.join(dir, 'snap-1.json'), '{"txId":0,"entries":[],"sha256":"00"}');
    const before = await dataFingerprint(dir);
    await expectCode(fileStorage(opts).open(), 'STORAGE_CORRUPT');
    expect(await dataFingerprint(dir)).toEqual(before);
    await writeFile(path.join(dir, 'MANIFEST'), 'not json');
    await expectCode(fileStorage(opts).open(), 'STORAGE_CORRUPT');
  });

  it('an empty MANIFEST, or a journal with data but no MANIFEST, fails closed', async () => {
    const manifest = await readFile(path.join(dir, 'MANIFEST'));
    await truncate(path.join(dir, 'MANIFEST'), 0);
    await expectCode(fileStorage(opts).open(), 'STORAGE_CORRUPT');
    await unlink(path.join(dir, 'MANIFEST'));
    const before = await dataFingerprint(dir);
    await expectCode(fileStorage(opts).open(), 'STORAGE_CORRUPT');
    expect(await dataFingerprint(dir)).toEqual(before);
    await writeFile(path.join(dir, 'MANIFEST'), manifest);
    expect(await readAll(opts)).toHaveLength(N);
  });

  it('many restarts keep every transaction', async () => {
    for (let round = 0; round < 15; round++) await writeTransactions(opts, 2, N + round * 2);
    expect(await readAll(opts)).toHaveLength(N + 30);
  });
});

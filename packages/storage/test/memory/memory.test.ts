import { describe, expect, it } from 'vitest';
import { createMemoryBacking, memoryStorage } from '../../src/memory/index.js';
import { crashingStorage, runStorageConformance } from '../../../testing/src/storage/index.js';

runStorageConformance('memory', async () => {
  const backing = createMemoryBacking();
  return { adapter: memoryStorage({ backing }), reopen: async () => memoryStorage({ backing }) };
});

runStorageConformance('memory behind a disarmed crashingStorage', async () => {
  const backing = createMemoryBacking();
  return { adapter: crashingStorage(memoryStorage({ backing })) };
});

describe('memory adapter specifics', () => {
  it('refuses a second open over the same backing', async () => {
    const backing = createMemoryBacking();
    const a = memoryStorage({ backing });
    await a.open();
    await expect(memoryStorage({ backing }).open()).rejects.toMatchObject({
      code: 'STORAGE_LOCKED',
    });
    await a.close();
    const b = memoryStorage({ backing });
    await expect(b.open()).resolves.toBeUndefined();
    await b.close();
  });

  it('refuses transactions before open and after close', async () => {
    const a = memoryStorage();
    await expect(a.transaction('ro', (tx) => tx.get('x'))).rejects.toMatchObject({
      code: 'STORAGE_ERROR',
    });
    await a.open();
    await a.close();
    await expect(a.transaction('ro', (tx) => tx.get('x'))).rejects.toMatchObject({
      code: 'STORAGE_ERROR',
    });
  });
});

describe('crashingStorage', () => {
  it('a crash at write k leaves nothing of that transaction', async () => {
    const backing = createMemoryBacking();
    const inner = memoryStorage({ backing });
    const crashing = crashingStorage(inner, { failAfterWrites: 1 });
    await crashing.open();
    await expect(
      crashing.transaction('rw', async (tx) => {
        tx.put('a', '1');
        tx.put('b', '2');
      }),
    ).rejects.toMatchObject({ details: { simulatedCrash: true } });
    expect(crashing.crashed).toBe(true);
    await expect(crashing.transaction('ro', (tx) => tx.get('a'))).rejects.toBeTruthy();
    expect(await inner.transaction('ro', (tx) => tx.get('a'))).toBeUndefined();
  });

  it('failAfterCommit commits, then throws before the caller sees the result', async () => {
    const inner = memoryStorage();
    const crashing = crashingStorage(inner);
    await crashing.open();
    crashing.arm({ failAfterCommit: true });
    await expect(
      crashing.transaction('rw', async (tx) => {
        tx.put('a', '1');
        return 'result';
      }),
    ).rejects.toMatchObject({ details: { simulatedCrash: true } });
    expect(crashing.commits).toBe(1);
    expect(await inner.transaction('ro', (tx) => tx.get('a'))).toBe('1');
  });

  it('failTransaction chooses the transaction and the crash point', async () => {
    const inner = memoryStorage();
    const crashing = crashingStorage(inner, {
      failTransaction: (i) => (i === 1 ? 'before-commit' : undefined),
    });
    await crashing.open();
    await crashing.transaction('rw', async (tx) => tx.put('first', 'ok'));
    await expect(
      crashing.transaction('rw', async (tx) => tx.put('second', 'lost')),
    ).rejects.toBeTruthy();
    expect(
      await inner.transaction('ro', async (tx) => [await tx.get('first'), await tx.get('second')]),
    ).toEqual(['ok', undefined]);
  });
});

/**
 * Storage adapter conformance suite (R9.3, design 9.2). Every shipped adapter must pass it, and
 * authors of custom adapters run it against their own adapter:
 *
 *   runStorageConformance('my adapter', async () => ({ adapter: myAdapter(), reopen: ... }));
 *
 * The factory returns an UNOPENED adapter. `reopen`, when given, must return a new unopened adapter
 * over the same data, to be used after the first one was closed (durability checks).
 */
import { describe, expect, it } from 'vitest';
import type { StorageAdapter } from '@weave/core/protocol';

export interface StorageFixture {
  readonly adapter: StorageAdapter;
  readonly reopen?: () => Promise<StorageAdapter>;
  readonly cleanup?: () => Promise<void>;
}

async function expectStorageError(p: Promise<unknown>): Promise<void> {
  await expect(p).rejects.toMatchObject({ code: 'STORAGE_ERROR' });
}

export function runStorageConformance(name: string, factory: () => Promise<StorageFixture>): void {
  async function withAdapter(body: (fixture: StorageFixture) => Promise<void>): Promise<void> {
    const fixture = await factory();
    await fixture.adapter.open();
    try {
      await body(fixture);
    } finally {
      await fixture.adapter.close().catch(() => undefined);
      await fixture.cleanup?.();
    }
  }

  describe(`storage conformance: ${name}`, () => {
    it('puts, gets and deletes', () =>
      withAdapter(async ({ adapter }) => {
        await adapter.transaction('rw', async (tx) => {
          tx.put('a/1', 'one');
          tx.put('a/2', '');
          tx.put('u/1', 'caf\u00e9 \ud83d\ude00');
        });
        const read = await adapter.transaction('ro', async (tx) => [
          await tx.get('a/1'),
          await tx.get('a/2'),
          await tx.get('u/1'),
          await tx.get('missing'),
        ]);
        expect(read).toEqual(['one', '', 'caf\u00e9 \ud83d\ude00', undefined]);
        await adapter.transaction('rw', async (tx) => {
          tx.delete('a/1');
          tx.delete('never-existed');
        });
        expect(await adapter.transaction('ro', (tx) => tx.get('a/1'))).toBeUndefined();
      }));

    it('returns the value of the transaction function', () =>
      withAdapter(async ({ adapter }) => {
        expect(await adapter.transaction('rw', async () => 42)).toBe(42);
      }));

    it('is atomic: a throwing transaction applies nothing', () =>
      withAdapter(async ({ adapter }) => {
        await adapter.transaction('rw', async (tx) => {
          tx.put('k/1', 'keep');
        });
        await expect(
          adapter.transaction('rw', async (tx) => {
            tx.put('k/2', 'lost');
            tx.delete('k/1');
            await tx.get('k/1');
            throw new Error('boom');
          }),
        ).rejects.toThrow('boom');
        const after = await adapter.transaction('ro', async (tx) => [
          await tx.get('k/1'),
          await tx.get('k/2'),
        ]);
        expect(after).toEqual(['keep', undefined]);
      }));

    it('reads its own writes, including deletes, in get and scan', () =>
      withAdapter(async ({ adapter }) => {
        await adapter.transaction('rw', async (tx) => {
          tx.put('p/a', '1');
          tx.put('p/b', '2');
        });
        await adapter.transaction('rw', async (tx) => {
          tx.put('p/c', '3');
          tx.delete('p/a');
          tx.put('p/b', '2b');
          expect(await tx.get('p/a')).toBeUndefined();
          expect(await tx.get('p/b')).toBe('2b');
          expect(await tx.scan('p/')).toEqual([
            ['p/b', '2b'],
            ['p/c', '3'],
          ]);
        });
      }));

    it('scans in ascending order with prefix, after and limit', () =>
      withAdapter(async ({ adapter }) => {
        const keys = ['s/10', 's/02', 's/01', 't/00', 's/1', 'r/99', 's/'];
        await adapter.transaction('rw', async (tx) => {
          for (const k of keys) tx.put(k, k.toUpperCase());
        });
        await adapter.transaction('ro', async (tx) => {
          expect((await tx.scan('s/')).map((e) => e[0])).toEqual([
            's/',
            's/01',
            's/02',
            's/1',
            's/10',
          ]);
          expect((await tx.scan('s/', { after: 's/02' })).map((e) => e[0])).toEqual([
            's/1',
            's/10',
          ]);
          expect((await tx.scan('s/', { limit: 2 })).map((e) => e[0])).toEqual(['s/', 's/01']);
          expect((await tx.scan('s/', { after: 's/01', limit: 1 })).map((e) => e[0])).toEqual([
            's/02',
          ]);
          expect((await tx.scan('', { limit: 1 })).map((e) => e[0])).toEqual(['r/99']);
          expect(await tx.scan('none/')).toEqual([]);
          expect((await tx.scan('s/1'))[0]).toEqual(['s/1', 'S/1']);
        });
      }));

    it('rejects writes in a read-only transaction', () =>
      withAdapter(async ({ adapter }) => {
        await expectStorageError(
          adapter.transaction('ro', async (tx) => {
            tx.put('x', 'y');
          }),
        );
        await expectStorageError(
          adapter.transaction('ro', async (tx) => {
            tx.delete('x');
          }),
        );
        expect(await adapter.transaction('ro', (tx) => tx.get('x'))).toBeUndefined();
      }));

    it('serializes concurrent transactions', () =>
      withAdapter(async ({ adapter }) => {
        await adapter.transaction('rw', async (tx) => {
          tx.put('counter', '0');
        });
        const increment = () =>
          adapter.transaction('rw', async (tx) => {
            const n = Number(await tx.get('counter'));
            await tx.get('other');
            tx.put('counter', String(n + 1));
          });
        await Promise.all(Array.from({ length: 20 }, increment));
        expect(await adapter.transaction('ro', (tx) => tx.get('counter'))).toBe('20');
      }));

    it('handles large batches', () =>
      withAdapter(async ({ adapter }) => {
        await adapter.transaction('rw', async (tx) => {
          for (let i = 0; i < 5000; i++) tx.put(`big/${String(i).padStart(5, '0')}`, `v${i}`);
        });
        const all = await adapter.transaction('ro', (tx) => tx.scan('big/'));
        expect(all).toHaveLength(5000);
        expect(all[0]).toEqual(['big/00000', 'v0']);
        expect(all[4999]).toEqual(['big/04999', 'v4999']);
      }));

    it('rejects use of a transaction object after it finished', () =>
      withAdapter(async ({ adapter }) => {
        let leaked: { put(k: string, v: string): void } | undefined;
        await adapter.transaction('rw', async (tx) => {
          leaked = tx;
        });
        expect(() => leaked!.put('late', 'x')).toThrow();
      }));

    it('keeps committed data across close and reopen', async () => {
      const fixture = await factory();
      if (fixture.reopen === undefined) {
        await fixture.cleanup?.();
        return;
      }
      await fixture.adapter.open();
      await fixture.adapter.transaction('rw', async (tx) => {
        tx.put('d/1', 'durable');
        tx.put('d/2', 'gone');
      });
      await fixture.adapter.transaction('rw', async (tx) => {
        tx.delete('d/2');
      });
      await expect(
        fixture.adapter.transaction('rw', async (tx) => {
          tx.put('d/3', 'never');
          throw new Error('abort');
        }),
      ).rejects.toThrow('abort');
      await fixture.adapter.close();
      const again = await fixture.reopen();
      await again.open();
      try {
        const values = await again.transaction('ro', async (tx) => [
          await tx.get('d/1'),
          await tx.get('d/2'),
          await tx.get('d/3'),
        ]);
        expect(values).toEqual(['durable', undefined, undefined]);
      } finally {
        await again.close();
        await fixture.cleanup?.();
      }
    });
  });
}

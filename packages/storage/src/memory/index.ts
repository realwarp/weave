/**
 * In-memory storage adapter (design 9). Used by tests and the quick start.
 *
 * A `MemoryBacking` holds the committed data. Several adapter objects can be created over the same
 * backing one after another, which models closing and reopening a database (durability tests).
 */
import { WeaveError, type StorageAdapter, type StorageTx } from '@weave/core/protocol';
import { SortedStore } from '../shared/sorted-store.js';
import { Mutex, OverlayTx } from '../shared/transaction.js';

export interface MemoryBacking {
  /** @internal */
  readonly store: SortedStore;
  /** @internal True while an adapter over this backing is open. */
  inUse: boolean;
}

export function createMemoryBacking(): MemoryBacking {
  return { store: new SortedStore(), inUse: false };
}

export interface MemoryStorageOptions {
  readonly backing?: MemoryBacking;
}

export function memoryStorage(options: MemoryStorageOptions = {}): StorageAdapter {
  const backing = options.backing ?? createMemoryBacking();
  const mutex = new Mutex();
  let state: 'new' | 'open' | 'closed' = 'new';

  return {
    open(): Promise<void> {
      if (state === 'open') return Promise.resolve();
      if (backing.inUse) {
        return Promise.reject(
          new WeaveError('STORAGE_LOCKED', 'The memory backing is already open'),
        );
      }
      backing.inUse = true;
      state = 'open';
      return Promise.resolve();
    },

    close(): Promise<void> {
      return mutex.run(() => {
        if (state === 'open') backing.inUse = false;
        state = 'closed';
        return Promise.resolve();
      });
    },

    transaction<T>(mode: 'ro' | 'rw', fn: (tx: StorageTx) => Promise<T>): Promise<T> {
      return mutex.run(async () => {
        if (state !== 'open')
          throw new WeaveError('STORAGE_ERROR', 'The storage adapter is not open');
        const tx = new OverlayTx(backing.store, mode);
        try {
          const result = await fn(tx);
          if (mode === 'rw') backing.store.apply(tx.writes);
          return result;
        } finally {
          tx.finish();
        }
      });
    },
  };
}

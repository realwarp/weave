/**
 * IndexedDB storage adapter for browsers (design 9): one object store `kv` with string keys, one
 * native IndexedDB transaction per `transaction` call (durability "strict" where supported), and a
 * Web Lock `weave:<name>` so only one tab writes to a database.
 *
 * IndexedDB closes a transaction when it has no pending request, so the transaction function may
 * only await calls on `tx` (design 9 contract).
 */
import { WeaveError, type StorageAdapter, type StorageTx } from '@weave/core/protocol';
import { Mutex } from '../shared/transaction.js';

const STORE = 'kv';

export interface IndexedDbStorageOptions {
  /** Database name; also the Web Lock name `weave:<name>`. */
  readonly name: string;
  /** Defaults to `globalThis.indexedDB`. */
  readonly indexedDB?: IDBFactory;
  /** Defaults to `navigator.locks` when available; `null` disables the writer lock. */
  readonly locks?: LockManager | null;
}

function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(new WeaveError('STORAGE_ERROR', 'IndexedDB request failed', { cause: request.error }));
  });
}

function openDatabase(factory: IDBFactory, name: string): Promise<IDBDatabase> {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = factory.open(name, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE)) request.result.createObjectStore(STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(
        new WeaveError('STORAGE_ERROR', 'Cannot open the IndexedDB database', {
          cause: request.error,
        }),
      );
    request.onblocked = () =>
      reject(
        new WeaveError('STORAGE_LOCKED', 'The IndexedDB database is blocked by another connection'),
      );
  });
}

function defaultLocks(): LockManager | null {
  const nav = (globalThis as { navigator?: { locks?: LockManager } }).navigator;
  return nav?.locks ?? null;
}

class IdbTx implements StorageTx {
  private finished = false;
  constructor(
    private readonly store: IDBObjectStore,
    private readonly mode: 'ro' | 'rw',
  ) {}

  finish(): void {
    this.finished = true;
  }

  private alive(): void {
    if (this.finished)
      throw new WeaveError('STORAGE_ERROR', 'The transaction has already finished');
  }

  async get(key: string): Promise<string | undefined> {
    this.alive();
    const value = (await requestToPromise(this.store.get(key))) as unknown;
    return typeof value === 'string' ? value : undefined;
  }

  put(key: string, value: string): void {
    this.alive();
    if (this.mode === 'ro') throw new WeaveError('STORAGE_ERROR', 'put in a read-only transaction');
    if (typeof key !== 'string' || key.length === 0)
      throw new WeaveError('STORAGE_ERROR', 'Invalid key');
    if (typeof value !== 'string')
      throw new WeaveError('STORAGE_ERROR', 'Storage values must be strings');
    this.store.put(value, key);
  }

  delete(key: string): void {
    this.alive();
    if (this.mode === 'ro')
      throw new WeaveError('STORAGE_ERROR', 'delete in a read-only transaction');
    this.store.delete(key);
  }

  scan(
    prefix: string,
    options: { readonly after?: string; readonly limit?: number } = {},
  ): Promise<Array<[string, string]>> {
    this.alive();
    const lower = options.after !== undefined && options.after >= prefix ? options.after : prefix;
    const lowerOpen = options.after !== undefined && options.after >= prefix;
    const range = IDBKeyRange.bound(lower, `${prefix}\uffff`, lowerOpen, false);
    const out: Array<[string, string]> = [];
    return new Promise((resolve, reject) => {
      const request = this.store.openCursor(range);
      request.onerror = () =>
        reject(new WeaveError('STORAGE_ERROR', 'IndexedDB scan failed', { cause: request.error }));
      request.onsuccess = () => {
        const cursor = request.result;
        if (cursor === null) return resolve(out);
        const key = cursor.key;
        if (typeof key === 'string' && key.startsWith(prefix) && typeof cursor.value === 'string') {
          out.push([key, cursor.value]);
          if (options.limit !== undefined && out.length >= options.limit) return resolve(out);
        }
        cursor.continue();
      };
    });
  }
}

export function indexedDbStorage(options: IndexedDbStorageOptions): StorageAdapter {
  const mutex = new Mutex();
  let db: IDBDatabase | undefined;
  let releaseLock: (() => void) | undefined;
  let state: 'new' | 'open' | 'closed' = 'new';

  async function acquireWebLock(): Promise<void> {
    const locks = options.locks === undefined ? defaultLocks() : options.locks;
    if (locks === null) return;
    await new Promise<void>((resolve, reject) => {
      void locks
        .request(`weave:${options.name}`, { ifAvailable: true }, (lock) => {
          if (lock === null) {
            reject(
              new WeaveError('STORAGE_LOCKED', `Database "${options.name}" is open in another tab`),
            );
            return undefined;
          }
          resolve();
          return new Promise<void>((release) => (releaseLock = release));
        })
        .catch(reject);
    });
  }

  return {
    open(): Promise<void> {
      return mutex.run(async () => {
        if (state === 'open') return;
        const factory = options.indexedDB ?? globalThis.indexedDB;
        if (factory === undefined)
          throw new WeaveError('STORAGE_ERROR', 'IndexedDB is not available here');
        await acquireWebLock();
        try {
          db = await openDatabase(factory, options.name);
        } catch (e) {
          releaseLock?.();
          releaseLock = undefined;
          throw e;
        }
        state = 'open';
      });
    },

    close(): Promise<void> {
      return mutex.run(() => {
        db?.close();
        db = undefined;
        releaseLock?.();
        releaseLock = undefined;
        state = 'closed';
        return Promise.resolve();
      });
    },

    transaction<T>(mode: 'ro' | 'rw', fn: (tx: StorageTx) => Promise<T>): Promise<T> {
      return mutex.run(async () => {
        if (state !== 'open' || db === undefined)
          throw new WeaveError('STORAGE_ERROR', 'The storage adapter is not open');
        const idbTx = db.transaction(STORE, mode === 'rw' ? 'readwrite' : 'readonly', {
          durability: 'strict',
        });
        const done = new Promise<void>((resolve, reject) => {
          idbTx.oncomplete = () => resolve();
          idbTx.onabort = () =>
            reject(
              new WeaveError('STORAGE_ERROR', 'IndexedDB transaction aborted', {
                cause: idbTx.error,
              }),
            );
          idbTx.onerror = () => undefined;
        });
        const tx = new IdbTx(idbTx.objectStore(STORE), mode);
        let result: T;
        try {
          result = await fn(tx);
        } catch (e) {
          tx.finish();
          try {
            idbTx.abort();
          } catch {
            // already finished
          }
          await done.catch(() => undefined);
          throw e;
        }
        tx.finish();
        await done;
        return result;
      });
    },
  };
}

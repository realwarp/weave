/**
 * Shared transaction mechanics for the memory and file adapters (design 9): a write-set overlay
 * over a committed `SortedStore`, read-your-writes, scans that merge the overlay, and a mutex that
 * serializes transactions of one adapter instance.
 */
import { WeaveError, type StorageTx } from '@weave/core/protocol';
import type { SortedStore } from './sorted-store.js';

export type ScanOptions = { readonly after?: string; readonly limit?: number };

function checkKey(key: string): void {
  if (typeof key !== 'string' || key.length === 0) {
    throw new WeaveError('STORAGE_ERROR', 'Storage keys must be non-empty strings');
  }
}

/** A transaction view over `base`. `writes` collects puts (string) and deletes (null). */
export class OverlayTx implements StorageTx {
  readonly writes = new Map<string, string | null>();
  private finished = false;

  constructor(
    private readonly base: SortedStore,
    private readonly mode: 'ro' | 'rw',
  ) {}

  finish(): void {
    this.finished = true;
  }

  private alive(): void {
    if (this.finished) {
      throw new WeaveError('STORAGE_ERROR', 'The transaction has already finished');
    }
  }

  get(key: string): Promise<string | undefined> {
    try {
      this.alive();
      checkKey(key);
    } catch (e) {
      return Promise.reject(e);
    }
    if (this.writes.has(key)) {
      const v = this.writes.get(key);
      return Promise.resolve(v === null ? undefined : v);
    }
    return Promise.resolve(this.base.get(key));
  }

  put(key: string, value: string): void {
    this.alive();
    if (this.mode === 'ro') throw new WeaveError('STORAGE_ERROR', 'put in a read-only transaction');
    checkKey(key);
    if (typeof value !== 'string')
      throw new WeaveError('STORAGE_ERROR', 'Storage values must be strings');
    this.writes.set(key, value);
  }

  delete(key: string): void {
    this.alive();
    if (this.mode === 'ro')
      throw new WeaveError('STORAGE_ERROR', 'delete in a read-only transaction');
    checkKey(key);
    this.writes.set(key, null);
  }

  scan(prefix: string, options: ScanOptions = {}): Promise<Array<[string, string]>> {
    try {
      this.alive();
    } catch (e) {
      return Promise.reject(e);
    }
    const keys = new Set(this.base.keysFrom(prefix, options.after));
    for (const key of this.writes.keys()) {
      if (key.startsWith(prefix) && (options.after === undefined || key > options.after))
        keys.add(key);
    }
    const out: Array<[string, string]> = [];
    for (const key of [...keys].sort()) {
      const pending = this.writes.get(key);
      const value = this.writes.has(key) ? pending : this.base.get(key);
      if (value === null || value === undefined) continue;
      out.push([key, value]);
      if (options.limit !== undefined && out.length >= options.limit) break;
    }
    return Promise.resolve(out);
  }
}

/** A FIFO async mutex. */
export class Mutex {
  private tail: Promise<void> = Promise.resolve();

  run<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.tail.then(fn);
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

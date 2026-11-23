/**
 * `crashingStorage` (design 9.2): wraps any adapter and simulates a process crash at a chosen
 * point, so tests can prove atomicity and recovery.
 *
 * - `failAfterWrites: k`: the k-th put or delete call (counted from arming, starting at 0) throws
 *   inside the transaction, so that transaction is NOT committed (crash before commit).
 * - `failAfterCommit: true`: the next read-write transaction commits durably, then the call throws
 *   before the caller sees its result (crash after commit, before the response).
 * - `failTransaction(index)`: decide per read-write transaction (index from arming) whether to
 *   crash 'before-commit' or 'after-commit'.
 *
 * After a crash the wrapper is dead: every further call rejects. Recovery is modelled by building a
 * new replica over the INNER adapter (or reopening the underlying data).
 */
import { WeaveError, type StorageAdapter, type StorageTx } from '@weave/core/protocol';

export type CrashPoint = 'before-commit' | 'after-commit';

export interface CrashOptions {
  readonly failAfterWrites?: number;
  readonly failAfterCommit?: boolean;
  readonly failTransaction?: (index: number) => CrashPoint | undefined;
}

export interface CrashingStorage extends StorageAdapter {
  /** Replaces the crash plan and resets the counters. */
  arm(options: CrashOptions): void;
  disarm(): void;
  /** Writes (put/delete) seen since arming. */
  readonly writes: number;
  /** Read-write transactions committed since arming. */
  readonly commits: number;
  readonly crashed: boolean;
  readonly inner: StorageAdapter;
}

function crashError(where: string): WeaveError {
  return new WeaveError('STORAGE_ERROR', `Simulated crash (${where})`, {
    details: { simulatedCrash: true },
  });
}

export function crashingStorage(
  inner: StorageAdapter,
  options: CrashOptions = {},
): CrashingStorage {
  let plan: CrashOptions = options;
  let writes = 0;
  let commits = 0;
  let rwIndex = 0;
  let crashed = false;

  const dead = (): Promise<never> => Promise.reject(crashError('storage is crashed'));

  const adapter: CrashingStorage = {
    get writes() {
      return writes;
    },
    get commits() {
      return commits;
    },
    get crashed() {
      return crashed;
    },
    inner,
    arm(next) {
      plan = next;
      writes = 0;
      commits = 0;
      rwIndex = 0;
      crashed = false;
    },
    disarm() {
      plan = {};
    },
    open: () => (crashed ? dead() : inner.open()),
    close: () => inner.close(),
    async transaction<T>(mode: 'ro' | 'rw', fn: (tx: StorageTx) => Promise<T>): Promise<T> {
      if (crashed) return dead();
      if (mode === 'ro') return inner.transaction('ro', fn);
      const index = rwIndex++;
      const decided = plan.failTransaction?.(index);
      const result = await inner.transaction('rw', async (tx) => {
        const counting: StorageTx = {
          get: (k) => tx.get(k),
          scan: (p, o) => tx.scan(p, o),
          put: (k, v) => {
            if (plan.failAfterWrites !== undefined && writes === plan.failAfterWrites) {
              crashed = true;
              throw crashError(`write ${writes}`);
            }
            writes++;
            tx.put(k, v);
          },
          delete: (k) => {
            if (plan.failAfterWrites !== undefined && writes === plan.failAfterWrites) {
              crashed = true;
              throw crashError(`write ${writes}`);
            }
            writes++;
            tx.delete(k);
          },
        };
        const value = await fn(counting);
        if (decided === 'before-commit') {
          crashed = true;
          throw crashError(`before commit of transaction ${index}`);
        }
        return value;
      });
      commits++;
      if (decided === 'after-commit' || plan.failAfterCommit === true) {
        crashed = true;
        throw crashError(`after commit of transaction ${index}`);
      }
      return result;
    },
  };
  return adapter;
}

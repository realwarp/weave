/**
 * Pending user actions (R5.4, design 13). Each user intent gets one `mutationId` when it starts.
 * The ID is stored with the pending action BEFORE the write, reused on every retry (also after a
 * reload or crash), and forgotten only once the result is recorded.
 */
import type { Replica, WriteResult } from '@weave/core';

export interface PendingStore {
  get(action: string): string | undefined;
  set(action: string, mutationId: string): void;
  delete(action: string): void;
}

export function memoryPending(): PendingStore {
  const map = new Map<string, string>();
  return {
    get: (a) => map.get(a),
    set: (a, id) => void map.set(a, id),
    delete: (a) => void map.delete(a),
  };
}

export function localPending(device: string, storage: Storage): PendingStore {
  const key = `fieldnote:${device}:pending`;
  const read = (): Record<string, string> =>
    JSON.parse(storage.getItem(key) ?? '{}') as Record<string, string>;
  const write = (v: Record<string, string>) => storage.setItem(key, JSON.stringify(v));
  return {
    get: (a) => read()[a],
    set: (a, id) => write({ ...read(), [a]: id }),
    delete: (a) => {
      const v = read();
      delete v[a];
      write(v);
    },
  };
}

export async function runAction(
  replica: Replica,
  pending: PendingStore,
  action: string,
  write: (mutationId: string) => Promise<WriteResult>,
): Promise<WriteResult> {
  let mutationId = pending.get(action);
  if (mutationId === undefined) {
    mutationId = replica.newMutationId();
    pending.set(action, mutationId);
  }
  const result = await write(mutationId);
  pending.delete(action);
  return result;
}

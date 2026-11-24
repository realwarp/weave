/**
 * Typed access to the storage key layout (design 3.4). All functions run inside a transaction and
 * only await calls on `tx` (IndexedDB contract, design 9).
 */
import { WeaveError } from '../contracts/errors.js';
import type { JsonValue } from '../contracts/json.js';
import type { Op } from '../contracts/op.js';
import type { ConflictRecord, DerivedRecord, MutationRecord } from '../contracts/state.js';
import {
  keys,
  padSeq,
  type MetaCompaction,
  type MetaSchema,
  type MetaState,
  type StorageTx,
} from '../contracts/storage.js';
import type { PeerEntry, SyncResult } from '../contracts/sync.js';

export const EMPTY_STATE: MetaState = { vector: {}, maxLamport: 0, commit: 0 };

function parse<T>(text: string | undefined, key: string): T | undefined {
  if (text === undefined) return undefined;
  try {
    return JSON.parse(text) as T;
  } catch (e) {
    throw new WeaveError('STORAGE_CORRUPT', `Stored value at ${key} is not valid JSON`, {
      cause: e,
      details: { key },
    });
  }
}

export async function readMetaState(tx: StorageTx): Promise<MetaState> {
  return parse<MetaState>(await tx.get(keys.metaState), keys.metaState) ?? EMPTY_STATE;
}

/** [ADV] Compaction state, or `undefined` when compaction was never used. */
export async function readCompaction(tx: StorageTx): Promise<MetaCompaction | undefined> {
  return parse<MetaCompaction>(await tx.get(keys.metaCompaction), keys.metaCompaction);
}

/** [ADV] Conflict history kept for a record after compaction (empty when none). */
export async function readArchive(
  tx: StorageTx,
  collection: string,
  recordId: string,
): Promise<ConflictRecord[]> {
  const key = keys.chist(collection, recordId);
  return parse<ConflictRecord[]>(await tx.get(key), key) ?? [];
}

export async function readMetaSchema(tx: StorageTx): Promise<MetaSchema> {
  return parse<MetaSchema>(await tx.get(keys.metaSchema), keys.metaSchema) ?? {};
}

export async function readRecord(
  tx: StorageTx,
  collection: string,
  recordId: string,
): Promise<DerivedRecord | undefined> {
  const key = keys.rec(collection, recordId);
  return parse<DerivedRecord>(await tx.get(key), key);
}

/** All accepted ops of one record, through the `rop/` index. */
export async function readRecordOps(
  tx: StorageTx,
  collection: string,
  recordId: string,
): Promise<Op[]> {
  const prefix = keys.ropPrefix(collection, recordId);
  const index = await tx.scan(prefix);
  const ops: Op[] = [];
  for (const [key] of index) {
    const rest = key.slice(prefix.length);
    const slash = rest.lastIndexOf('/');
    const origin = rest.slice(0, slash);
    const seq = Number(rest.slice(slash + 1));
    const line = await tx.get(keys.op(origin, seq));
    if (line === undefined) {
      throw new WeaveError('STORAGE_CORRUPT', 'The record index names a missing op', {
        details: { key },
      });
    }
    ops.push(JSON.parse(line) as Op);
  }
  return ops;
}

export async function readOpLine(
  tx: StorageTx,
  origin: string,
  seq: number,
): Promise<string | undefined> {
  return tx.get(keys.op(origin, seq));
}

export async function readMutation(
  tx: StorageTx,
  mutationId: string,
): Promise<MutationRecord | undefined> {
  const key = keys.mut(mutationId);
  return parse<MutationRecord>(await tx.get(key), key);
}

/** Stored form of a sync result: the error is kept as plain data. */
type StoredPeer = Omit<PeerEntry, 'lastResult'> & {
  lastResult?: Omit<SyncResult, 'error'> & { error?: { code: string; message: string } };
};

export async function readPeer(tx: StorageTx, peerId: string): Promise<PeerEntry | undefined> {
  const key = keys.peer(peerId);
  const stored = parse<StoredPeer>(await tx.get(key), key);
  if (stored === undefined) return undefined;
  if (stored.lastResult?.error !== undefined) {
    const { error, ...rest } = stored.lastResult;
    return {
      ...stored,
      lastResult: {
        ...rest,
        error: new WeaveError(error.code as never, error.message),
      } as unknown as SyncResult,
    };
  }
  return stored as PeerEntry;
}

export function writePeer(tx: StorageTx, peerId: string, entry: PeerEntry): void {
  const result = entry.lastResult;
  const stored: StoredPeer =
    result !== undefined && 'error' in result
      ? {
          ...entry,
          lastResult: {
            ...result,
            error: { code: result.error.code, message: result.error.message },
          },
        }
      : (entry as StoredPeer);
  tx.put(keys.peer(peerId), JSON.stringify(stored));
}

export function seqKeyRange(origin: string, afterSeq: number): { prefix: string; after: string } {
  return { prefix: keys.opPrefix(origin), after: `${keys.opPrefix(origin)}${padSeq(afterSeq)}` };
}

export type FieldValues = Record<string, JsonValue>;

export function valuesOf(record: DerivedRecord): FieldValues {
  const out: FieldValues = {};
  for (const [name, f] of Object.entries(record.fields)) out[name] = f.value;
  return out;
}

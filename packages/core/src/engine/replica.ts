/**
 * The replica engine (design 7): open and upgrade, the local write path with mandatory mutation IDs,
 * the apply path for received ops (validation, schema prefix rule, pending buffer, atomic
 * promotion), conflict notifications, hashes, status, rebuild and the replica's own endpoint.
 */
import { compareUtf8 } from '../canonical/encode.js';
import {
  conflictViewHash,
  mutationPayloadHash,
  opSetHash,
  stateHash,
  type StateEntry,
} from '../canonical/hash.js';
import type { Clock, Random, Scheduler } from '../contracts/env.js';
import { WeaveError } from '../contracts/errors.js';
import type { Logger, WeaveEvent } from '../contracts/events.js';
import type { JsonValue, ReplicaId, VersionVector } from '../contracts/json.js';
import type { Op, OpHistoryEntry } from '../contracts/op.js';
import type {
  BootstrapReport,
  ChangeEvent,
  Collection,
  CompactionOptions,
  CompactionReport,
  ConflictApi,
  ConflictFilter,
  CreateReplicaOptions,
  Query,
  RecordView,
  Replica,
  ReplicaStatus,
  SyncHost,
  WriteOptions,
  WriteResult,
} from '../contracts/replica.js';
import type { CollectionDefinition, FieldSpec, InferRecord } from '../contracts/schema.js';
import type { ConflictRecord, DerivedRecord, Hashes } from '../contracts/state.js';
import {
  keys,
  type MetaCompaction,
  type MetaState,
  type StorageAdapter,
  type StorageTx,
} from '../contracts/storage.js';
import type {
  ApplyResult,
  BlockedOrigin,
  CompactionInfo,
  PeerEntry,
  Rejection,
  Snapshot,
  Support,
  SyncEndpoint,
  SyncOptions,
  SyncResult,
} from '../contracts/sync.js';
import { systemClock, systemScheduler } from '../ops/clock.js';
import { buildOp, readEnvelope, verifyOpLine } from '../ops/op.js';
import { compareD4, opIdKey, toOpId } from '../ops/order.js';
import { newMutationId, newRecordId, newReplicaId, platformRandom } from '../ops/random.js';
import { mergeVectors, normalizeVector, vectorDifference } from '../ops/vector.js';
import {
  MUTATION_ID_PATTERN,
  migrateAndCheck,
  supportOf,
  validateLocalWrite,
} from '../schema/index.js';
import { buildOpHistory, conflictHistory, deriveRecord } from '../state/index.js';
import { isDeleted, restoreEnabled } from '../state/restore.js';
import { migratedSetOps } from '../state/derive.js';
import { applyCounterDelta, mergeCounterStates } from '../resolvers/counter.js';
import { selectReadablePrefix, isSupported } from '../sync/select.js';
import { SNAPSHOT_FORMAT, sealSnapshot, verifySnapshotEnvelope } from '../sync/snapshot.js';
import {
  EMPTY_COMPACTION,
  advanceCompactedThrough,
  assertNotRemoved,
  assertServable,
  capHorizon,
  closedSetHorizon,
  mergeArchive,
  planRecord,
} from '../sync/compaction.js';
import { runSync } from '../sync/engine.js';
import { Mutex } from './mutex.js';
import {
  EMPTY_STATE,
  readMetaSchema,
  readMetaState,
  readArchive,
  readCompaction,
  readMutation,
  readPeer,
  readRecord,
  readRecordOps,
  valuesOf,
  writePeer,
} from './store.js';

/** [ADV] A `restore` op is accepted only by a collection that enables it (R6.9, A1/A2). */
function assertRestoreAccepted(definition: AnyDefinition): void {
  if (!restoreEnabled(definition)) {
    throw new WeaveError(
      'NOT_SUPPORTED',
      `Collection "${definition.name}" does not enable restore (deletes.restore)`,
      { details: { collection: definition.name } },
    );
  }
}

/**
 * [ADV] Turns the counter deltas of a local write into counter states (R6.10): the merge of every
 * state this replica holds for the field, plus the delta on this replica's own totals. The op then
 * causally follows every op it merged, so the field's frontier always carries the full count.
 */
function withCounterStates(
  definition: AnyDefinition,
  ops: readonly Op[],
  replicaId: ReplicaId,
  fields: Readonly<Record<string, JsonValue>>,
): Readonly<Record<string, JsonValue>> {
  const names = Object.keys(fields).filter((n) => definition.fields[n]?.kind === 'counter');
  if (names.length === 0) return fields;
  const migrated = migratedSetOps(ops, definition);
  const out: Record<string, JsonValue> = { ...fields };
  for (const name of names) {
    const states = migrated.filter((m) => name in m.fields).map((m) => m.fields[name]!);
    const merged = mergeCounterStates(states);
    out[name] = applyCounterDelta(
      merged,
      replicaId,
      fields[name] as number,
    ) as unknown as JsonValue;
  }
  return out;
}

/**
 * [ADV] A record re-derived after compaction still lists every conflict ID it ever had: the
 * archive keeps the history of discarded ops (ADR-0006). Without compaction the archive is empty
 * and the record is unchanged.
 */
function withArchive(record: DerivedRecord, archive: readonly ConflictRecord[]): DerivedRecord {
  if (archive.length === 0) return record;
  const ids = new Set([...record.conflictHistoryIds, ...archive.map((c) => c.conflictId)]);
  return { ...record, conflictHistoryIds: [...ids].sort() };
}

const MAX_PENDING_PER_ORIGIN = 5000;
const MAX_COMMIT_RETRIES = 3;

type AnyDefinition = CollectionDefinition<Record<string, FieldSpec>>;

interface Touched {
  readonly collection: string;
  readonly recordId: string;
}

interface PendingEntry {
  readonly line: string;
  readonly hash: string;
}

class Engine implements Replica, SyncHost {
  readonly id: ReplicaId;
  readonly replicaId: ReplicaId;
  readonly clock: Clock;
  readonly random: Random;
  readonly scheduler: Scheduler;
  readonly conflicts: ConflictApi;
  private readonly mutex = new Mutex();
  private readonly listeners = new Set<(change: ChangeEvent) => void>();
  private readonly definitions: Map<string, AnyDefinition>;
  private syncState: ReplicaStatus['state'] = 'idle';
  private closed = false;

  constructor(
    readonly storage: StorageAdapter,
    definitions: readonly AnyDefinition[],
    replicaId: ReplicaId,
    private readonly logger: Logger | undefined,
    clock: Clock,
    random: Random,
    scheduler: Scheduler,
    private readonly compactionOptions: CompactionOptions | undefined = undefined,
  ) {
    this.id = replicaId;
    this.replicaId = replicaId;
    this.clock = clock;
    this.random = random;
    this.scheduler = scheduler;
    this.definitions = new Map(definitions.map((d) => [d.name, d]));
    this.conflicts = {
      current: (filter) => this.currentConflicts(filter),
      history: (filter) => this.historyConflicts(filter),
    };
  }

  // ---------------------------------------------------------------- utilities

  emit(event: WeaveEvent): void {
    if (this.logger === undefined) return;
    try {
      this.logger(event);
    } catch {
      // A failing logger never breaks the engine.
    }
  }

  private notifyChange(change: ChangeEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(change);
      } catch {
        // Listener errors are isolated.
      }
    }
  }

  private alive(): void {
    if (this.closed) throw new WeaveError('STORAGE_ERROR', 'The replica is closed');
  }

  runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    return this.mutex.run(fn);
  }

  setState(state: ReplicaStatus['state']): void {
    this.syncState = state;
  }

  support(): Support {
    return supportOf([...this.definitions.values()]);
  }

  private definition(name: string): AnyDefinition {
    const d = this.definitions.get(name);
    if (d === undefined) throw new WeaveError('VALIDATION_FAILED', `Unknown collection "${name}"`);
    return d;
  }

  newMutationId(): string {
    return newMutationId(this.random);
  }

  // ---------------------------------------------------------------- reads used by sync

  readVector(): Promise<VersionVector> {
    return this.storage.transaction('ro', async (tx) => (await readMetaState(tx)).vector);
  }

  readOps(
    origin: ReplicaId,
    afterSeq: number,
    limit: number,
  ): Promise<Array<{ seq: number; collection: string; schemaVersion: number; line: string }>> {
    return this.storage.transaction('ro', async (tx) => {
      // [ADV] Never serve partial history (R3.9).
      const compaction = await readCompaction(tx);
      if (compaction !== undefined && limit > 0)
        assertServable(compaction.compactedThrough, origin, afterSeq);
      const prefix = keys.opPrefix(origin);
      const rows = await tx.scan(prefix, { after: keys.op(origin, afterSeq), limit });
      return rows.map(([, line]) => {
        const env = readEnvelope(line);
        return { seq: env.seq, collection: env.collection, schemaVersion: env.schemaVersion, line };
      });
    });
  }

  readPeer(peerId: string): Promise<PeerEntry | undefined> {
    return this.storage.transaction('ro', (tx) => readPeer(tx, peerId));
  }

  writePeer(peerId: string, entry: PeerEntry): Promise<void> {
    return this.storage.transaction('rw', async (tx) => writePeer(tx, peerId, entry));
  }

  pendingBufferSize(): Promise<number> {
    return this.storage.transaction('ro', async (tx) => (await tx.scan(keys.pendPrefix())).length);
  }

  // ---------------------------------------------------------------- local writes (design 7.2)

  collection<D extends AnyDefinition>(definition: D): Collection<InferRecord<D>> {
    const registered = this.definitions.get(definition.name);
    if (registered === undefined) {
      throw new WeaveError(
        'VALIDATION_FAILED',
        `Collection "${definition.name}" is not registered on this replica`,
      );
    }
    const name = definition.name;
    type T = InferRecord<D>;
    return {
      create: (value: T, options: WriteOptions) =>
        this.write(name, 'create', null, value as unknown, options),
      update: (recordId: string, patch: Partial<T>, options: WriteOptions) =>
        this.write(name, 'update', recordId, patch as unknown, options),
      delete: (recordId: string, options: WriteOptions) =>
        this.write(name, 'delete', recordId, {}, options),
      restore: (recordId: string, options: WriteOptions) =>
        this.write(name, 'restore', recordId, {}, options),
      get: (recordId: string) => this.get<T>(name, recordId),
      query: (query?: Query<T>) => this.query<T>(name, query),
      history: (recordId: string) => this.opHistory(name, recordId),
    };
  }

  private async write(
    collection: string,
    action: 'create' | 'update' | 'delete' | 'restore',
    recordId: string | null,
    value: unknown,
    options: WriteOptions | undefined,
  ): Promise<WriteResult> {
    this.alive();
    const mutationId = (options as { mutationId?: unknown } | undefined)?.mutationId;
    if (typeof mutationId !== 'string' || !MUTATION_ID_PATTERN.test(mutationId)) {
      throw new WeaveError(
        'VALIDATION_FAILED',
        'Every create, update and delete needs a stable caller-supplied mutationId (1 to 128 characters of [A-Za-z0-9_.:-])',
        { details: { mutationId } },
      );
    }
    const definition = this.definition(collection);
    if (action === 'restore') assertRestoreAccepted(definition);
    const kind = action === 'delete' || action === 'restore' ? action : 'set';
    const fields =
      kind === 'set'
        ? validateLocalWrite(definition, action === 'create' ? 'create' : 'update', value)
        : {};
    const payloadHash = await mutationPayloadHash({ collection, kind, recordId, fields });

    return this.mutex.run(async () => {
      for (let attempt = 0; ; attempt++) {
        const pre = await this.storage.transaction('ro', async (tx) => {
          const mutation = await readMutation(tx, mutationId);
          const state = await readMetaState(tx);
          const ops = recordId === null ? [] : await readRecordOps(tx, collection, recordId);
          const archive = recordId === null ? [] : await readArchive(tx, collection, recordId);
          return { mutation, state, ops, archive };
        });
        if (pre.mutation !== undefined) {
          if (pre.mutation.payloadHash !== payloadHash) {
            throw new WeaveError(
              'MUTATION_ID_REUSED',
              `mutationId "${mutationId}" was already used for a different change`,
              {
                details: { mutationId },
              },
            );
          }
          return { recordId: pre.mutation.recordId, opId: pre.mutation.opId, replayed: true };
        }
        if (recordId !== null) {
          if (pre.ops.length === 0) {
            throw new WeaveError(
              'VALIDATION_FAILED',
              `Record "${recordId}" does not exist in "${collection}"`,
            );
          }
          // D6: without `deletes` options this is "any delete op held" (0.1.0).
          const deleted = isDeleted(pre.ops, definition);
          if (action === 'restore' && !deleted) {
            throw new WeaveError(
              'VALIDATION_FAILED',
              `Record "${recordId}" in "${collection}" is not deleted`,
              { details: { collection, recordId } },
            );
          }
          if (action !== 'restore' && deleted) {
            throw new WeaveError('RECORD_DELETED', `Record "${recordId}" was deleted`, {
              details: { collection, recordId },
            });
          }
        }
        const id = recordId ?? newRecordId(this.random);
        const { op, line } = await buildOp({
          replicaId: this.replicaId,
          vector: pre.state.vector,
          maxLamport: pre.state.maxLamport,
          collection,
          recordId: id,
          kind,
          schemaVersion: definition.version,
          // [ADV] Counter deltas become counter states, read in this same attempt (R6.10).
          fields: withCounterStates(definition, pre.ops, this.replicaId, fields),
          wallTime: this.clock.nowMs(),
        });
        const record = withArchive(
          await deriveRecord([...pre.ops, op], definition, collection, id),
          pre.archive,
        );
        const nextState: MetaState = {
          vector: normalizeVector({ ...pre.state.vector, [this.replicaId]: op.seq }),
          maxLamport: Math.max(pre.state.maxLamport, op.lamport),
          commit: pre.state.commit + 1,
        };
        try {
          await this.storage.transaction('rw', async (tx) => {
            const current = await readMetaState(tx);
            if (current.commit !== pre.state.commit) {
              throw new WeaveError('STORAGE_CONFLICT', 'The data changed during the write');
            }
            tx.put(keys.op(op.replicaId, op.seq), line);
            tx.put(keys.rop(collection, id, op.replicaId, op.seq), '');
            tx.put(keys.rec(collection, id), JSON.stringify(record));
            tx.put(
              keys.mut(mutationId),
              JSON.stringify({ payloadHash, opId: toOpId(op), recordId: id }),
            );
            tx.put(keys.metaState, JSON.stringify(nextState));
          });
        } catch (e) {
          if (
            e instanceof WeaveError &&
            e.code === 'STORAGE_CONFLICT' &&
            attempt < MAX_COMMIT_RETRIES
          )
            continue;
          throw e;
        }
        this.emit({ type: 'op.applied', opId: toOpId(op), source: 'local' });
        await this.markAndNotify([{ collection, recordId: id }]);
        this.notifyChange({ source: 'local', collection, recordId: id, kind });
        return { recordId: id, opId: toOpId(op), replayed: false };
      }
    });
  }

  // ---------------------------------------------------------------- reads

  private async get<T>(collection: string, recordId: string): Promise<RecordView<T> | undefined> {
    this.alive();
    this.definition(collection);
    const record = await this.storage.transaction('ro', (tx) =>
      readRecord(tx, collection, recordId),
    );
    if (record === undefined || record.deleted) return undefined;
    return { id: recordId, value: valuesOf(record) as T, conflicts: record.conflicts };
  }

  private async query<T>(collection: string, query: Query<T> = {}): Promise<Array<RecordView<T>>> {
    this.alive();
    this.definition(collection);
    const rows = await this.storage.transaction('ro', (tx) => tx.scan(keys.recPrefix(collection)));
    const prefix = keys.recPrefix(collection);
    const out: Array<RecordView<T> & { deleted: boolean }> = [];
    for (const [key, text] of rows) {
      const record = JSON.parse(text) as DerivedRecord;
      if (record.deleted && query.includeDeleted !== true) continue;
      const value = valuesOf(record);
      const where = (query.where ?? {}) as Record<string, unknown>;
      if (!Object.entries(where).every(([k, v]) => JSON.stringify(value[k]) === JSON.stringify(v)))
        continue;
      out.push({
        id: key.slice(prefix.length),
        value: value as T,
        conflicts: record.conflicts,
        deleted: record.deleted,
      });
    }
    const orderBy = query.orderBy;
    const sign = query.direction === 'desc' ? -1 : 1;
    out.sort((a, b) => {
      if (orderBy !== undefined) {
        const va = (a.value as Record<string, unknown>)[orderBy];
        const vb = (b.value as Record<string, unknown>)[orderBy];
        const c = compareValues(va, vb);
        if (c !== 0) return c * sign;
      }
      return compareUtf8(a.id, b.id);
    });
    return out.map(({ deleted: _deleted, ...view }) => view);
  }

  private async opHistory(collection: string, recordId: string): Promise<OpHistoryEntry[]> {
    this.alive();
    this.definition(collection);
    const ops = await this.storage.transaction('ro', (tx) =>
      readRecordOps(tx, collection, recordId),
    );
    return buildOpHistory(ops);
  }

  subscribe(listener: (change: ChangeEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private async recordsInScope(
    filter: ConflictFilter = {},
  ): Promise<Array<[string, string, DerivedRecord]>> {
    const prefix =
      filter.collection === undefined
        ? keys.recPrefix()
        : filter.recordId === undefined
          ? keys.recPrefix(filter.collection)
          : keys.rec(filter.collection, filter.recordId);
    const rows = await this.storage.transaction('ro', (tx) => tx.scan(prefix));
    const out: Array<[string, string, DerivedRecord]> = [];
    for (const [key, text] of rows) {
      const [, collection, recordId] = key.split('/') as [string, string, string];
      if (filter.recordId !== undefined && recordId !== filter.recordId) continue;
      out.push([collection, recordId, JSON.parse(text) as DerivedRecord]);
    }
    return out;
  }

  private async currentConflicts(filter?: ConflictFilter): Promise<ConflictRecord[]> {
    this.alive();
    return (await this.recordsInScope(filter)).flatMap(([, , r]) => r.conflicts);
  }

  private async historyConflicts(filter?: ConflictFilter): Promise<ConflictRecord[]> {
    this.alive();
    const out: ConflictRecord[] = [];
    for (const [collection, recordId] of await this.recordsInScope(filter)) {
      const definition = this.definitions.get(collection);
      if (definition === undefined) continue;
      const { ops, archive } = await this.storage.transaction('ro', async (tx) => ({
        ops: await readRecordOps(tx, collection, recordId),
        archive: await readArchive(tx, collection, recordId),
      }));
      const replay = await conflictHistory(ops, definition, collection, recordId);
      out.push(...(archive.length === 0 ? replay : mergeArchive(archive, replay)));
    }
    return out;
  }

  // ---------------------------------------------------------------- notifications (D8, design 6.1)

  /** Mark-then-emit: at-most-once per conflict ID. */
  private async markAndNotify(touched: readonly Touched[]): Promise<void> {
    const records = await this.storage.transaction('ro', async (tx) => {
      const list: Array<{ record: DerivedRecord; fresh: string[] }> = [];
      for (const t of touched) {
        const record = await readRecord(tx, t.collection, t.recordId);
        if (record === undefined) continue;
        const fresh: string[] = [];
        for (const id of record.conflictHistoryIds) {
          if ((await tx.get(keys.notified(id))) === undefined) fresh.push(id);
        }
        list.push({ record, fresh });
      }
      return list;
    });
    const fresh = [...new Set(records.flatMap((r) => r.fresh))];
    if (fresh.length === 0) return;
    await this.storage.transaction('rw', async (tx) => {
      for (const id of fresh) tx.put(keys.notified(id), '');
    });
    const open = new Set(records.flatMap((r) => r.record.conflicts.map((c) => c.conflictId)));
    for (const id of fresh.sort()) {
      this.emit({
        type: 'conflict.new',
        conflictId: id,
        status: open.has(id) ? 'open' : 'superseded',
      });
    }
  }

  /** Startup repair: every committed conflict ID missing from `notified/` (including superseded). */
  async repairNotifications(): Promise<void> {
    const rows = await this.storage.transaction('ro', (tx) => tx.scan(keys.recPrefix()));
    const touched = rows.map(([key]) => {
      const [, collection, recordId] = key.split('/') as [string, string, string];
      return { collection, recordId };
    });
    await this.markAndNotify(touched);
  }

  // ---------------------------------------------------------------- apply path (design 7.3)

  applyIncoming = (lines: readonly string[], peerId: ReplicaId): Promise<ApplyResult> => {
    this.alive();
    return this.mutex.run(() => this.applyLocked(lines, peerId, false));
  };

  /** At open: promote buffered ops that became contiguous, and clean stale buffer entries. */
  sweepPending(): Promise<ApplyResult> {
    return this.mutex.run(() => this.applyLocked([], this.replicaId, true));
  }

  private async applyLocked(
    lines: readonly string[],
    peerId: ReplicaId,
    sweep: boolean,
  ): Promise<ApplyResult> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.applyOnce(lines, peerId, sweep);
      } catch (e) {
        if (
          e instanceof WeaveError &&
          e.code === 'STORAGE_CONFLICT' &&
          attempt < MAX_COMMIT_RETRIES
        )
          continue;
        throw e;
      }
    }
  }

  private async applyOnce(
    lines: readonly string[],
    peerId: ReplicaId,
    sweep: boolean,
  ): Promise<ApplyResult> {
    // Phase A1: verify every line. Any failure rejects the whole batch.
    const verified: Array<{ op: Op; line: string }> = [];
    for (const line of lines) verified.push({ op: await verifyOpLine(line), line });
    // [ADV] Ops a removed member wrote after its removal are refused (R3.10).
    if (verified.length > 0) {
      const compaction = await this.storage.transaction('ro', (tx) => readCompaction(tx));
      if (compaction !== undefined)
        for (const { op } of verified) assertNotRemoved(compaction.removed, op);
    }

    // Phase A2: application schema of readable ops.
    for (const { op } of verified) {
      const definition = this.definitions.get(op.collection);
      if (definition === undefined || op.schemaVersion > definition.version) continue;
      if (op.kind === 'restore') {
        assertRestoreAccepted(definition);
        continue;
      }
      if (op.kind === 'delete') continue;
      migrateAndCheck(definition, {
        fields: op.fields,
        recordId: op.recordId,
        fromVersion: op.schemaVersion,
      });
    }

    // Phase A3 step 1: conflict scan inside the batch.
    const byId = new Map<string, { op: Op; line: string }>();
    for (const v of verified) {
      const key = opIdKey(v.op);
      const existing = byId.get(key);
      if (existing !== undefined && existing.op.hash !== v.op.hash) this.integrityConflict(v.op);
      if (existing === undefined) byId.set(key, v); // step 2: collapse identical copies
    }
    let duplicates = verified.length - byId.size;

    const origins = new Set<string>([...byId.values()].map((v) => v.op.replicaId));
    const snapshot = await this.storage.transaction('ro', async (tx) => {
      const state = await readMetaState(tx);
      const stored = new Map<string, string | undefined>();
      const pending = new Map<string, PendingEntry>();
      for (const { op } of byId.values())
        stored.set(opIdKey(op), await tx.get(keys.op(op.replicaId, op.seq)));
      const pendOrigins = sweep ? await this.pendingOrigins(tx) : origins;
      for (const origin of pendOrigins) {
        for (const [key, line] of await tx.scan(keys.pendPrefix(origin))) {
          const seq = Number(key.slice(keys.pendPrefix(origin).length));
          pending.set(`${origin}:${seq}`, { line, hash: readEnvelope(line).hash });
        }
      }
      return { state, stored, pending, pendOrigins };
    });

    // Phase A3 steps 1 and 3 against storage (accepted and buffered).
    const fresh: Array<{ op: Op; line: string }> = [];
    for (const v of byId.values()) {
      const key = opIdKey(v.op);
      const storedLine = snapshot.stored.get(key);
      const storedHash = storedLine === undefined ? undefined : readEnvelope(storedLine).hash;
      const pendingHash = snapshot.pending.get(key)?.hash;
      for (const h of [storedHash, pendingHash])
        if (h !== undefined && h !== v.op.hash) this.integrityConflict(v.op);
      if (storedHash !== undefined || pendingHash !== undefined) {
        duplicates++;
        this.emit({ type: 'op.duplicate', opId: toOpId(v.op) });
        continue;
      }
      fresh.push(v);
    }

    // Phase B: prefix, gap and promotion logic per origin.
    const support = this.support();
    const vector: Record<string, number> = { ...snapshot.state.vector };
    const accepted: Array<{ op: Op; line: string; promoted: boolean }> = [];
    const toBuffer: Array<{ op: Op; line: string }> = [];
    const dropPending: string[] = [];
    const rejected: Rejection[] = [];
    const blocked: BlockedOrigin[] = [];
    const need: Record<ReplicaId, number> = {};

    const byOrigin = new Map<string, Array<{ op: Op; line: string }>>();
    for (const v of fresh)
      byOrigin.set(v.op.replicaId, [...(byOrigin.get(v.op.replicaId) ?? []), v]);
    const allOrigins = new Set<string>([...byOrigin.keys(), ...snapshot.pendOrigins]);

    for (const origin of [...allOrigins].sort()) {
      const incoming = (byOrigin.get(origin) ?? []).sort((a, b) => a.op.seq - b.op.seq);
      let next = (vector[origin] ?? 0) + 1;
      let stopped = false;

      const promote = async (): Promise<void> => {
        for (;;) {
          const entry = snapshot.pending.get(`${origin}:${next}`);
          if (entry === undefined) return;
          let op: Op;
          try {
            op = await verifyOpLine(entry.line);
            if (op.replicaId !== origin || op.seq !== next || op.hash !== entry.hash)
              throw new Error('mismatch');
          } catch {
            dropPending.push(keys.pend(origin, next));
            need[origin] = next;
            this.emit({
              type: 'error',
              code: 'STORAGE_CORRUPT',
              message: 'A damaged buffer entry was dropped',
            });
            return;
          }
          if (!isSupported(op, support)) {
            dropPending.push(keys.pend(origin, next));
            rejected.push({ origin, seq: next, code: 'SCHEMA_TOO_NEW' });
            stopped = true;
            return;
          }
          accepted.push({ op, line: entry.line, promoted: true });
          dropPending.push(keys.pend(origin, next));
          next++;
        }
      };

      await promote();
      for (const v of incoming) {
        if (stopped) break;
        const { op } = v;
        if (op.seq < next) {
          duplicates++;
          continue;
        }
        if (op.seq === next) {
          if (!isSupported(op, support)) {
            rejected.push({ origin, seq: op.seq, code: 'SCHEMA_TOO_NEW' });
            blocked.push({
              origin,
              seq: op.seq,
              collection: op.collection,
              requiredVersion: op.schemaVersion,
              direction: 'push',
            });
            stopped = true;
            break;
          }
          accepted.push({ op, line: v.line, promoted: false });
          next++;
          await promote();
          continue;
        }
        // Gap: buffer if readable (insert-if-absent; existing entries were found in A3).
        need[origin] = next;
        const buffered = [...snapshot.pending.keys()].filter((k) =>
          k.startsWith(`${origin}:`),
        ).length;
        if (
          isSupported(op, support) &&
          buffered + toBuffer.filter((b) => b.op.replicaId === origin).length <
            MAX_PENDING_PER_ORIGIN
        ) {
          toBuffer.push(v);
          this.emit({ type: 'op.buffered', opId: toOpId(op), need: next });
        }
      }
      if (next - 1 > (vector[origin] ?? 0)) vector[origin] = next - 1;
      if (sweep) {
        // Stale entries at or below the vector: identical copies are removed, others are corrupt.
        for (const [key, entry] of snapshot.pending) {
          const [o, s] = key.split(':') as [string, string];
          if (o !== origin || Number(s) > (snapshot.state.vector[origin] ?? 0)) continue;
          const storedLine = await this.storage.transaction('ro', (tx) =>
            tx.get(keys.op(o, Number(s))),
          );
          if (storedLine !== undefined && readEnvelope(storedLine).hash === entry.hash)
            dropPending.push(keys.pend(o, Number(s)));
          else
            throw new WeaveError('STORAGE_CORRUPT', 'A buffered op conflicts with an accepted op', {
              details: { key },
            });
        }
      }
    }

    // Phase C: derive touched records, then commit everything in one transaction.
    const touched = new Map<string, Touched>();
    for (const a of accepted)
      touched.set(`${a.op.collection}/${a.op.recordId}`, {
        collection: a.op.collection,
        recordId: a.op.recordId,
      });
    const records = new Map<string, DerivedRecord>();
    if (touched.size > 0) {
      const existing = await this.storage.transaction('ro', async (tx) => {
        const m = new Map<string, { ops: Op[]; archive: ConflictRecord[] }>();
        for (const [k, t] of touched)
          m.set(k, {
            ops: await readRecordOps(tx, t.collection, t.recordId),
            archive: await readArchive(tx, t.collection, t.recordId),
          });
        return m;
      });
      for (const [k, t] of touched) {
        const definition = this.definition(t.collection);
        const ops = [
          ...(existing.get(k)?.ops ?? []),
          ...accepted.filter((a) => `${a.op.collection}/${a.op.recordId}` === k).map((a) => a.op),
        ];
        records.set(
          k,
          withArchive(
            await deriveRecord(ops, definition, t.collection, t.recordId),
            existing.get(k)?.archive ?? [],
          ),
        );
      }
    }
    const maxLamport = Math.max(snapshot.state.maxLamport, ...accepted.map((a) => a.op.lamport));
    const nextState: MetaState = {
      vector: normalizeVector(vector),
      maxLamport,
      commit: snapshot.state.commit + 1,
    };
    const changed = accepted.length > 0 || toBuffer.length > 0 || dropPending.length > 0;
    if (changed) {
      await this.storage.transaction('rw', async (tx) => {
        const current = await readMetaState(tx);
        if (current.commit !== snapshot.state.commit)
          throw new WeaveError('STORAGE_CONFLICT', 'Data changed during apply');
        for (const a of accepted) {
          const already = await tx.get(keys.op(a.op.replicaId, a.op.seq));
          if (already !== undefined)
            throw new WeaveError('STORAGE_CONFLICT', 'An op was accepted concurrently');
          if (a.promoted) {
            const p = await tx.get(keys.pend(a.op.replicaId, a.op.seq));
            if (p === undefined || readEnvelope(p).hash !== a.op.hash)
              throw new WeaveError('STORAGE_CONFLICT', 'A buffer entry changed');
          }
          tx.put(keys.op(a.op.replicaId, a.op.seq), a.line);
          tx.put(keys.rop(a.op.collection, a.op.recordId, a.op.replicaId, a.op.seq), '');
        }
        for (const b of toBuffer) {
          const key = keys.pend(b.op.replicaId, b.op.seq);
          const existing = await tx.get(key);
          if (existing === undefined) tx.put(key, b.line);
          else if (readEnvelope(existing).hash !== b.op.hash)
            throw new WeaveError('STORAGE_CONFLICT', 'A buffer entry appeared');
        }
        for (const key of dropPending) tx.delete(key);
        for (const [k, record] of records) {
          const t = touched.get(k)!;
          tx.put(keys.rec(t.collection, t.recordId), JSON.stringify(record));
        }
        tx.put(keys.metaState, JSON.stringify(nextState));
      });
    }

    const promoted = accepted.filter((a) => a.promoted).length;
    for (const a of accepted) {
      this.emit({
        type: 'op.applied',
        opId: toOpId(a.op),
        source: a.promoted ? 'promotion' : 'sync',
      });
    }
    if (touched.size > 0) await this.markAndNotify([...touched.values()]);
    for (const a of [...accepted].sort((x, y) => compareD4(x.op, y.op))) {
      this.notifyChange({
        source: 'sync',
        collection: a.op.collection,
        recordId: a.op.recordId,
        kind: a.op.kind,
      });
    }
    void peerId;
    return {
      vector: changed ? nextState.vector : snapshot.state.vector,
      rejected,
      need,
      blocked,
      duplicates,
      promoted,
      applied: accepted.length,
    };
  }

  private async pendingOrigins(tx: StorageTx): Promise<Set<string>> {
    const out = new Set<string>();
    for (const [key] of await tx.scan(keys.pendPrefix())) out.add(key.split('/')[1]!);
    return out;
  }

  private integrityConflict(op: Op): never {
    this.emit({
      type: 'error',
      code: 'REPLICA_ID_REUSE',
      message: 'Two different ops claim one op ID',
      opId: toOpId(op),
    });
    throw new WeaveError(
      'INTEGRITY_CONFLICT',
      'Two different ops claim the same (replicaId, seq)',
      {
        details: { replicaId: op.replicaId, seq: op.seq, status: 'REPLICA_ID_REUSE' },
      },
    );
  }

  // ---------------------------------------------------------------- endpoint (design 8.1)

  endpoint(): SyncEndpoint {
    return {
      pull: async (request) => {
        this.alive();
        const vector = await this.readVector();
        const selected = await selectReadablePrefix({
          senderVector: vector,
          peerVector: request.vector,
          support: request.support,
          limit: request.limit,
          direction: 'pull',
          ...(request.origins === undefined ? {} : { origins: request.origins }),
          read: (origin, after, limit) => this.readOps(origin, after, limit),
        });
        return {
          endpointId: this.replicaId,
          durable: vector,
          support: this.support(),
          ops: selected.lines,
          blocked: selected.blocked,
          more: selected.more,
        };
      },
      push: async (request) => {
        this.alive();
        const result = await this.applyIncoming(request.ops, request.replicaId);
        const pushed: Record<string, number> = {};
        for (const line of request.ops) {
          const env = readEnvelope(line);
          if (env.seq <= (result.vector[env.replicaId] ?? 0))
            pushed[env.replicaId] = Math.max(pushed[env.replicaId] ?? 0, env.seq);
        }
        await this.mergePeerAck(request.replicaId, pushed, request.support);
        return {
          durable: result.vector,
          rejected: result.rejected,
          need: result.need,
          blocked: result.blocked,
        };
      },
      ack: async (request) => {
        this.alive();
        await this.mergePeerAck(request.replicaId, request.durable);
      },
      // [ADV] A replica serves its own snapshot for direct bootstrapping (R4.8).
      snapshot: () => this.exportSnapshot(),
    };
  }

  private mergePeerAck(peerId: string, vector: VersionVector, support?: Support): Promise<void> {
    return this.storage.transaction('rw', async (tx) => {
      const current = (await readPeer(tx, peerId)) ?? { ackVector: {}, support: {} };
      writePeer(tx, peerId, {
        ...current,
        ackVector: mergeVectors(current.ackVector, vector),
        ...(support === undefined ? {} : { support }),
      });
    });
  }

  // ---------------------------------------------------------------- sync, status, hashes, rebuild

  sync(endpoint: SyncEndpoint, options: SyncOptions = {}): Promise<SyncResult> {
    this.alive();
    return runSync(this, endpoint, options);
  }

  async status(): Promise<ReplicaStatus> {
    this.alive();
    return this.storage.transaction('ro', async (tx) => {
      const state = await readMetaState(tx);
      const pendingBuffer = (await tx.scan(keys.pendPrefix())).length;
      const peers: Record<string, ReplicaStatus['peers'][string]> = {};
      for (const [key] of await tx.scan(keys.peerPrefix)) {
        const peerId = key.slice(keys.peerPrefix.length);
        const entry = await readPeer(tx, peerId);
        if (entry === undefined) continue;
        peers[peerId] = {
          ackVector: entry.ackVector,
          pendingOps: vectorDifference(state.vector, entry.ackVector),
          ...(entry.lastResult === undefined ? {} : { lastResult: entry.lastResult }),
          ...(entry.lastSyncWall === undefined ? {} : { lastSyncWall: entry.lastSyncWall }),
        };
      }
      const compaction = await readCompaction(tx);
      return {
        state: this.syncState,
        vector: state.vector,
        pendingBuffer,
        peers,
        ...(compaction === undefined ? {} : { compaction }),
      };
    });
  }

  async hashes(): Promise<Hashes> {
    this.alive();
    const { recs, ops } = await this.storage.transaction('ro', async (tx) => ({
      recs: await tx.scan(keys.recPrefix()),
      ops: await tx.scan('op/'),
    }));
    const entries: StateEntry[] = [];
    const open: Array<[string, JsonValue | undefined]> = [];
    for (const [key, text] of recs) {
      const [, collection, recordId] = key.split('/') as [string, string, string];
      const record = JSON.parse(text) as DerivedRecord;
      entries.push([collection, recordId, record.deleted, valuesOf(record)]);
      for (const c of record.conflicts) open.push([c.conflictId, c.resolved]);
    }
    return {
      state: await stateHash(entries),
      ops: await opSetHash(ops.map(([, line]) => readEnvelope(line).hash)),
      conflicts: await conflictViewHash(open),
    };
  }

  async rebuild(): Promise<void> {
    this.alive();
    await this.mutex.run(async () => {
      const groups = await this.storage.transaction('ro', (tx) => listRecords(tx));
      await rewriteRecords(this.storage, [...this.definitions.values()], groups, undefined);
    });
  }

  // ---------------------------------------------------------------- [ADV] snapshots (R4.8)

  async exportSnapshot(): Promise<Snapshot> {
    this.alive();
    return this.mutex.run(async () => {
      const data = await this.storage.transaction('ro', async (tx) => ({
        state: await readMetaState(tx),
        compaction: (await readCompaction(tx)) ?? EMPTY_COMPACTION,
        ops: await tx.scan('op/'),
        archives: await tx.scan('chist/'),
      }));
      return sealSnapshot({
        format: SNAPSHOT_FORMAT,
        source: this.replicaId,
        vector: data.state.vector,
        maxLamport: data.state.maxLamport,
        compactedThrough: data.compaction.compactedThrough,
        removed: data.compaction.removed,
        ops: data.ops.map(([, line]) => line),
        archives: data.archives.map(([key, text]) => {
          const [, collection, recordId] = key.split('/') as [string, string, string];
          return [collection, recordId, JSON.parse(text) as JsonValue[]] as const;
        }),
      });
    });
  }

  async bootstrap(source: Snapshot | SyncEndpoint): Promise<BootstrapReport> {
    this.alive();
    let raw: unknown;
    if ('format' in source) raw = source;
    else if (source.snapshot !== undefined) raw = await source.snapshot();
    else throw new WeaveError('NOT_SUPPORTED', 'The endpoint does not serve snapshots');
    const { snapshot, ops } = await verifySnapshotEnvelope(raw);
    if ((snapshot.vector[this.replicaId] ?? 0) > 0)
      throw new WeaveError(
        'VALIDATION_FAILED',
        'The snapshot already holds ops of this replica ID; rejoin with a new, empty replica',
      );
    // Application schema: every readable op must validate, and none may need a newer schema.
    for (const op of ops) {
      const definition = this.definitions.get(op.collection);
      if (definition === undefined) continue;
      if (op.schemaVersion > definition.version)
        throw new WeaveError('SCHEMA_TOO_NEW', 'The snapshot needs a newer schema; upgrade first', {
          details: { collection: op.collection, requiredVersion: op.schemaVersion },
        });
      if (op.kind === 'restore') assertRestoreAccepted(definition);
      else if (op.kind === 'set')
        migrateAndCheck(definition, {
          fields: op.fields,
          recordId: op.recordId,
          fromVersion: op.schemaVersion,
        });
    }
    return this.mutex.run(async () => {
      const empty = await this.storage.transaction('ro', async (tx) => {
        const state = await readMetaState(tx);
        return (
          Object.keys(state.vector).length === 0 &&
          (await tx.scan('op/', { limit: 1 })).length === 0 &&
          (await tx.scan(keys.pendPrefix(), { limit: 1 })).length === 0 &&
          (await tx.scan(keys.recPrefix(), { limit: 1 })).length === 0
        );
      });
      if (!empty)
        throw new WeaveError(
          'VALIDATION_FAILED',
          'Only an empty replica can bootstrap from a snapshot',
        );

      const archives = new Map<string, ConflictRecord[]>();
      for (const [collection, recordId, entries] of snapshot.archives)
        archives.set(`${collection}/${recordId}`, entries as unknown as ConflictRecord[]);
      const groups = new Map<string, { collection: string; recordId: string; ops: Op[] }>();
      for (const op of ops) {
        const k = `${op.collection}/${op.recordId}`;
        const g = groups.get(k) ?? { collection: op.collection, recordId: op.recordId, ops: [] };
        g.ops.push(op);
        groups.set(k, g);
      }
      const records: Array<{ key: string; record: DerivedRecord }> = [];
      for (const [k, g] of groups) {
        const definition = this.definitions.get(g.collection);
        if (definition === undefined) continue;
        const record = withArchive(
          await deriveRecord(g.ops, definition, g.collection, g.recordId),
          archives.get(k) ?? [],
        );
        records.push({ key: keys.rec(g.collection, g.recordId), record });
      }
      const lineOf = new Map(snapshot.ops.map((l, i) => [i, l]));
      await this.storage.transaction('rw', async (tx) => {
        const current = await readMetaState(tx);
        ops.forEach((op, i) => {
          tx.put(keys.op(op.replicaId, op.seq), lineOf.get(i)!);
          tx.put(keys.rop(op.collection, op.recordId, op.replicaId, op.seq), '');
        });
        for (const [k, entries] of archives) {
          const [collection, recordId] = k.split('/') as [string, string];
          tx.put(keys.chist(collection, recordId), JSON.stringify(entries));
        }
        for (const { key, record } of records) {
          tx.put(key, JSON.stringify(record));
          // Conflicts that happened before this device joined are history, not news.
          for (const id of record.conflictHistoryIds) tx.put(keys.notified(id), '');
        }
        const compaction: MetaCompaction = {
          horizon: {},
          compactedThrough: snapshot.compactedThrough,
          removed: snapshot.removed,
        };
        tx.put(keys.metaCompaction, JSON.stringify(compaction));
        tx.put(
          keys.metaState,
          JSON.stringify({
            vector: snapshot.vector,
            maxLamport: snapshot.maxLamport,
            commit: current.commit + 1,
          } satisfies MetaState),
        );
      });
      return {
        source: snapshot.source,
        ops: ops.length,
        records: records.length,
        vector: snapshot.vector,
      };
    });
  }

  // ---------------------------------------------------------------- [ADV] compaction (R3.6 to R3.10)

  /** Stores the horizon and removed list a relay published (latest horizon wins). */
  noteCompaction = async (info: CompactionInfo): Promise<void> => {
    this.alive();
    await this.mutex.run(() =>
      this.storage.transaction('rw', async (tx) => {
        const stored = await readCompaction(tx);
        const current = stored ?? EMPTY_COMPACTION;
        const removed = { ...current.removed };
        for (const [id, through] of Object.entries(info.removed))
          removed[id] = Math.min(removed[id] ?? through, through);
        const next: MetaCompaction = {
          horizon: normalizeVector(info.horizon),
          compactedThrough: current.compactedThrough,
          removed,
        };
        // Stored even when empty: an empty horizon is a known horizon (nothing may be discarded).
        if (stored === undefined || JSON.stringify(next) !== JSON.stringify(current))
          tx.put(keys.metaCompaction, JSON.stringify(next));
      }),
    );
  };

  async removePeer(replicaId: ReplicaId): Promise<void> {
    this.alive();
    if (replicaId === this.replicaId)
      throw new WeaveError('VALIDATION_FAILED', 'A replica cannot remove itself');
    await this.mutex.run(() =>
      this.storage.transaction('rw', async (tx) => {
        const current = (await readCompaction(tx)) ?? EMPTY_COMPACTION;
        if (current.removed[replicaId] !== undefined) return;
        const held = (await readMetaState(tx)).vector[replicaId] ?? 0;
        const next: MetaCompaction = {
          ...current,
          removed: { ...current.removed, [replicaId]: held },
        };
        tx.put(keys.metaCompaction, JSON.stringify(next));
      }),
    );
  }

  /** The horizon this replica may compact to, or `undefined` when none is known. */
  private async currentHorizon(): Promise<VersionVector | undefined> {
    return this.storage.transaction('ro', async (tx) => {
      const state = await readMetaState(tx);
      const compaction = (await readCompaction(tx)) ?? EMPTY_COMPACTION;
      const members = this.compactionOptions?.members;
      if (members !== undefined) {
        const acks = new Map<string, VersionVector>();
        for (const m of members) acks.set(m, (await readPeer(tx, m))?.ackVector ?? {});
        return closedSetHorizon(this.replicaId, state.vector, members, acks, compaction.removed);
      }
      if ((await tx.get(keys.metaCompaction)) === undefined) return undefined;
      return capHorizon(compaction.horizon, state.vector);
    });
  }

  async compact(): Promise<CompactionReport> {
    this.alive();
    if (this.compactionOptions?.enabled !== true)
      throw new WeaveError('NOT_SUPPORTED', 'Compaction is off; enable it in createReplica');
    return this.mutex.run(async () => {
      const horizon = await this.currentHorizon();
      if (horizon === undefined)
        throw new WeaveError(
          'NOT_SUPPORTED',
          'No horizon is known: sync with a relay, or declare a closed replica set (members)',
        );
      const loaded = await this.storage.transaction('ro', async (tx) => {
        const state = await readMetaState(tx);
        const compaction = (await readCompaction(tx)) ?? EMPTY_COMPACTION;
        const groups = await listRecords(tx);
        const list: Array<{
          collection: string;
          recordId: string;
          ops: Op[];
          stored: DerivedRecord;
          archive: ConflictRecord[];
        }> = [];
        for (const [collection, ids] of groups) {
          if (!this.definitions.has(collection)) continue;
          for (const recordId of ids) {
            const stored = await readRecord(tx, collection, recordId);
            if (stored === undefined) continue;
            list.push({
              collection,
              recordId,
              ops: await readRecordOps(tx, collection, recordId),
              stored,
              archive: await readArchive(tx, collection, recordId),
            });
          }
        }
        const mutations = await tx.scan('mut/');
        return { state, compaction, list, mutations };
      });

      const removedOps: Op[] = [];
      const writes: Array<{ collection: string; recordId: string; archive: ConflictRecord[] }> = [];
      for (const r of loaded.list) {
        const definition = this.definition(r.collection);
        // [ADV] With restore or update-wins a deleted record can become live again, and which
        // deletes count depends on concurrent sets, so its ops all stay (ADR-0015, T5.3).
        const keepTombstones =
          restoreEnabled(definition) || definition.deletes?.policy === 'update-wins';
        const plan = await planRecord(
          r.ops,
          r.stored,
          horizon,
          (ops) => deriveRecord(ops, definition, r.collection, r.recordId),
          { keepTombstones },
        );
        if (plan.remove.length === 0) continue;
        const replay = await conflictHistory(r.ops, definition, r.collection, r.recordId);
        removedOps.push(...plan.remove);
        writes.push({
          collection: r.collection,
          recordId: r.recordId,
          archive: mergeArchive(r.archive, replay),
        });
      }
      const compactedThrough = advanceCompactedThrough(
        loaded.compaction.compactedThrough,
        removedOps,
      );
      const report: CompactionReport = {
        horizon,
        removedOps: removedOps.length,
        records: writes.length,
        compactedThrough,
      };
      if (removedOps.length === 0) return report;

      const gone = new Set(removedOps.map((o) => opIdKey(o)));
      const mutKeys = loaded.mutations
        .filter(([, text]) => {
          const m = JSON.parse(text) as { opId: { replicaId: string; seq: number } };
          return gone.has(opIdKey(m.opId));
        })
        .map(([key]) => key);
      await this.storage.transaction('rw', async (tx) => {
        const current = await readMetaState(tx);
        if (current.commit !== loaded.state.commit)
          throw new WeaveError('STORAGE_CONFLICT', 'Data changed during compaction');
        for (const op of removedOps) {
          tx.delete(keys.op(op.replicaId, op.seq));
          tx.delete(keys.rop(op.collection, op.recordId, op.replicaId, op.seq));
        }
        for (const key of mutKeys) tx.delete(key);
        for (const w of writes)
          tx.put(keys.chist(w.collection, w.recordId), JSON.stringify(w.archive));
        tx.put(
          keys.metaCompaction,
          JSON.stringify({ ...loaded.compaction, compactedThrough } satisfies MetaCompaction),
        );
        tx.put(keys.metaState, JSON.stringify({ ...current, commit: current.commit + 1 }));
      });
      return report;
    });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    await this.mutex.run(async () => {
      this.closed = true;
      await this.storage.close();
    });
  }
}

function compareValues(a: unknown, b: unknown): number {
  if (a === b) return 0;
  if (a === undefined) return 1;
  if (b === undefined) return -1;
  if (typeof a === 'number' && typeof b === 'number') return a < b ? -1 : 1;
  if (typeof a === 'string' && typeof b === 'string') return compareUtf8(a, b);
  return compareUtf8(JSON.stringify(a), JSON.stringify(b));
}

/** Every record that has ops, from the `rop/` index: collection to record IDs. */
async function listRecords(tx: StorageTx, collection?: string): Promise<Map<string, Set<string>>> {
  const out = new Map<string, Set<string>>();
  for (const [key] of await tx.scan(collection === undefined ? 'rop/' : `rop/${collection}/`)) {
    const [, c, r] = key.split('/') as [string, string, string];
    if (!out.has(c)) out.set(c, new Set());
    out.get(c)!.add(r);
  }
  return out;
}

/** Re-derives the given records and writes them (with optional extra writes) in ONE transaction. */
async function rewriteRecords(
  storage: StorageAdapter,
  definitions: readonly AnyDefinition[],
  groups: Map<string, Set<string>>,
  extra: ((tx: StorageTx) => void) | undefined,
): Promise<void> {
  const byName = new Map(definitions.map((d) => [d.name, d]));
  const loaded = await storage.transaction('ro', async (tx) => {
    const list: Array<{
      collection: string;
      recordId: string;
      ops: Op[];
      archive: ConflictRecord[];
    }> = [];
    for (const [collection, ids] of groups) {
      if (!byName.has(collection)) continue;
      for (const recordId of ids)
        list.push({
          collection,
          recordId,
          ops: await readRecordOps(tx, collection, recordId),
          archive: await readArchive(tx, collection, recordId),
        });
    }
    return list;
  });
  const derived: Array<{ key: string; value: string }> = [];
  for (const { collection, recordId, ops, archive } of loaded) {
    const record = withArchive(
      await deriveRecord(ops, byName.get(collection)!, collection, recordId),
      archive,
    );
    derived.push({ key: keys.rec(collection, recordId), value: JSON.stringify(record) });
  }
  await storage.transaction('rw', async (tx) => {
    for (const d of derived) tx.put(d.key, d.value);
    extra?.(tx);
  });
}

/** Opens (and if needed creates or upgrades) a replica over `options.storage` (design 7.1, 5.3). */
export async function createReplica(options: CreateReplicaOptions): Promise<Replica> {
  const definitions = [...options.collections];
  const names = new Set<string>();
  for (const d of definitions) {
    if (names.has(d.name))
      throw new WeaveError('VALIDATION_FAILED', `Collection "${d.name}" is registered twice`);
    names.add(d.name);
  }
  const random = options.random ?? platformRandom;
  const storage = options.storage;
  await storage.open();
  try {
    const meta = await storage.transaction('ro', async (tx) => ({
      replica: await tx.get(keys.metaReplica),
      state: await tx.get(keys.metaState),
      schema: await readMetaSchema(tx),
    }));
    const replicaId =
      meta.replica === undefined
        ? newReplicaId(random)
        : (JSON.parse(meta.replica) as { replicaId: string }).replicaId;

    const upgrades: string[] = [];
    const nextSchema: Record<string, number> = { ...meta.schema };
    for (const d of definitions) {
      const stored = meta.schema[d.name];
      if (stored !== undefined && stored > d.version) {
        throw new WeaveError(
          'SCHEMA_DOWNGRADE',
          `Stored data of "${d.name}" uses schema version ${stored}; this code supports ${d.version}`,
          {
            details: { collection: d.name, stored, code: d.version },
          },
        );
      }
      if (stored !== undefined && stored < d.version) upgrades.push(d.name);
      nextSchema[d.name] = d.version;
    }
    const schemaChanged = JSON.stringify(nextSchema) !== JSON.stringify(meta.schema);

    const writeMeta = (tx: StorageTx): void => {
      if (meta.replica === undefined) tx.put(keys.metaReplica, JSON.stringify({ replicaId }));
      if (meta.state === undefined) tx.put(keys.metaState, JSON.stringify(EMPTY_STATE));
      tx.put(keys.metaSchema, JSON.stringify(nextSchema));
    };

    if (upgrades.length > 0) {
      const groups = await storage.transaction('ro', async (tx) => {
        const all = new Map<string, Set<string>>();
        for (const name of upgrades)
          for (const [c, ids] of await listRecords(tx, name)) all.set(c, ids);
        return all;
      });
      // One transaction: rebuilt records, new schema versions, and a cleared pending buffer (3.5).
      const pend = await storage.transaction('ro', (tx) => tx.scan(keys.pendPrefix()));
      await rewriteRecords(storage, definitions, groups, (tx) => {
        writeMeta(tx);
        for (const [key] of pend) tx.delete(key);
      });
    } else if (meta.replica === undefined || meta.state === undefined || schemaChanged) {
      const pend = schemaChanged
        ? await storage.transaction('ro', (tx) => tx.scan(keys.pendPrefix()))
        : [];
      await storage.transaction('rw', async (tx) => {
        writeMeta(tx);
        for (const [key] of pend) tx.delete(key);
      });
    }

    const engine = new Engine(
      storage,
      definitions,
      replicaId,
      options.logger,
      options.clock ?? systemClock,
      random,
      options.scheduler ?? systemScheduler,
      options.compaction,
    );
    await engine.sweepPending();
    await engine.repairNotifications();
    return engine;
  } catch (e) {
    await storage.close().catch(() => undefined);
    throw e;
  }
}

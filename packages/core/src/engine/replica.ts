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
  ChangeEvent,
  Collection,
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
import { keys, type MetaState, type StorageAdapter, type StorageTx } from '../contracts/storage.js';
import type {
  ApplyResult,
  BlockedOrigin,
  PeerEntry,
  Rejection,
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
import { selectReadablePrefix, isSupported } from '../sync/select.js';
import { runSync } from '../sync/engine.js';
import { Mutex } from './mutex.js';
import {
  EMPTY_STATE,
  readMetaSchema,
  readMetaState,
  readMutation,
  readPeer,
  readRecord,
  readRecordOps,
  valuesOf,
  writePeer,
} from './store.js';

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
      get: (recordId: string) => this.get<T>(name, recordId),
      query: (query?: Query<T>) => this.query<T>(name, query),
      history: (recordId: string) => this.opHistory(name, recordId),
    };
  }

  private async write(
    collection: string,
    action: 'create' | 'update' | 'delete',
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
    const kind = action === 'delete' ? 'delete' : 'set';
    const fields =
      action === 'delete'
        ? {}
        : validateLocalWrite(definition, action === 'create' ? 'create' : 'update', value);
    const payloadHash = await mutationPayloadHash({ collection, kind, recordId, fields });

    return this.mutex.run(async () => {
      for (let attempt = 0; ; attempt++) {
        const pre = await this.storage.transaction('ro', async (tx) => {
          const mutation = await readMutation(tx, mutationId);
          const state = await readMetaState(tx);
          const ops = recordId === null ? [] : await readRecordOps(tx, collection, recordId);
          return { mutation, state, ops };
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
          if (pre.ops.some((o) => o.kind === 'delete')) {
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
          fields,
          wallTime: this.clock.nowMs(),
        });
        const record = await deriveRecord([...pre.ops, op], definition, collection, id);
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
      const ops = await this.storage.transaction('ro', (tx) =>
        readRecordOps(tx, collection, recordId),
      );
      out.push(...(await conflictHistory(ops, definition, collection, recordId)));
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

    // Phase A2: application schema of readable ops.
    for (const { op } of verified) {
      const definition = this.definitions.get(op.collection);
      if (definition === undefined || op.schemaVersion > definition.version || op.kind === 'delete')
        continue;
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
        const m = new Map<string, Op[]>();
        for (const [k, t] of touched) m.set(k, await readRecordOps(tx, t.collection, t.recordId));
        return m;
      });
      for (const [k, t] of touched) {
        const definition = this.definition(t.collection);
        const ops = [
          ...(existing.get(k) ?? []),
          ...accepted.filter((a) => `${a.op.collection}/${a.op.recordId}` === k).map((a) => a.op),
        ];
        records.set(k, await deriveRecord(ops, definition, t.collection, t.recordId));
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
      return { state: this.syncState, vector: state.vector, pendingBuffer, peers };
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
    const list: Array<{ collection: string; recordId: string; ops: Op[] }> = [];
    for (const [collection, ids] of groups) {
      if (!byName.has(collection)) continue;
      for (const recordId of ids)
        list.push({ collection, recordId, ops: await readRecordOps(tx, collection, recordId) });
    }
    return list;
  });
  const derived: Array<{ key: string; value: string }> = [];
  for (const { collection, recordId, ops } of loaded) {
    const record = await deriveRecord(ops, byName.get(collection)!, collection, recordId);
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
    );
    await engine.sweepPending();
    await engine.repairNotifications();
    return engine;
  } catch (e) {
    await storage.close().catch(() => undefined);
    throw e;
  }
}

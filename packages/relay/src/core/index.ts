/**
 * RelayCore (R4a, design 10.2, 10.3): a durable, semantically opaque store-and-forward peer.
 *
 * - It verifies every op line (structure, D7 values, canonical form, D2 hash) and identity, but
 *   never interprets field values, applies schemas, runs migrations or resolves conflicts.
 * - Accepted ops are stored byte for byte and acknowledged only after the commit (R4a.3).
 * - Pushes go through one queue, and the commit transaction re-checks identity, so two concurrent
 *   pushes of one op ID can never store two versions.
 * - Acknowledgements (design 10.3): a member's ack vector rises only through its AckRequest or the
 *   validated contiguous prefix it pushed; a pull never raises it.
 */
import {
  WeaveError,
  keys,
  mergeVectors,
  newReplicaId,
  normalizeVector,
  platformRandom,
  readEnvelope,
  selectReadablePrefix,
  verifyOpLine,
  type AckRequest,
  type PullRequest,
  type PullResponse,
  type PushRequest,
  type PushResponse,
  type Random,
  type ReplicaId,
  type StorageAdapter,
  type StorageTx,
  type SyncEndpoint,
  type VersionVector,
} from '@weave/core/protocol';
import { computeHorizon } from './compaction.js';

export interface RelayLimits {
  /** Maximum ops in one push (default 500). */
  readonly maxOpsPerPush: number;
  /** Maximum ops returned by one pull (default 500). */
  readonly maxOpsPerPull: number;
  /** Maximum bytes of one op line (default 64 KiB). */
  readonly maxOpBytes: number;
}

export const DEFAULT_LIMITS: RelayLimits = {
  maxOpsPerPush: 500,
  maxOpsPerPull: 500,
  maxOpBytes: 64 * 1024,
};

export interface RelayCoreOptions {
  readonly storage: StorageAdapter;
  readonly random?: Random;
  readonly limits?: Partial<RelayLimits>;
  /** TEST ONLY: disable the push queue (to prove the transaction re-check alone is enough). */
  readonly unsafeDisableQueue?: boolean;
  /** TEST ONLY: disable the in-transaction identity re-check (to prove the queue alone is enough). */
  readonly unsafeDisableRecheck?: boolean;
  /** Compaction options (off by default). */
  readonly compaction?: { enabled: boolean };
}

interface RelayState {
  readonly vector: VersionVector;
  readonly commit: number;
}

interface MemberEntry {
  readonly ackVector: VersionVector;
}

interface CompactionState {
  readonly compactedThrough: VersionVector;
  readonly removed: Readonly<Record<ReplicaId, number>>;
}

const STATE_KEY = 'meta/relay';
const COMPACTED_KEY = 'meta/compaction';

class Queue {
  private tail: Promise<void> = Promise.resolve();
  run<T>(fn: () => Promise<T>): Promise<T> {
    const r = this.tail.then(fn);
    this.tail = r.then(
      () => undefined,
      () => undefined,
    );
    return r;
  }
}

async function readState(tx: StorageTx): Promise<RelayState> {
  const text = await tx.get(STATE_KEY);
  return text === undefined ? { vector: {}, commit: 0 } : (JSON.parse(text) as RelayState);
}

async function readCompaction(tx: StorageTx): Promise<CompactionState> {
  const text = await tx.get(COMPACTED_KEY);
  return text === undefined
    ? { compactedThrough: {}, removed: {} }
    : (JSON.parse(text) as CompactionState);
}

async function readMember(tx: StorageTx, id: ReplicaId): Promise<MemberEntry | undefined> {
  const text = await tx.get(keys.peer(id));
  return text === undefined ? undefined : (JSON.parse(text) as MemberEntry);
}

function integrity(origin: string, seq: number): WeaveError {
  return new WeaveError('INTEGRITY_CONFLICT', 'Two different ops claim the same (replicaId, seq)', {
    details: { replicaId: origin, seq, status: 'REPLICA_ID_REUSE' },
  });
}

export class RelayCore implements SyncEndpoint {
  private readonly queue = new Queue();
  private readonly limits: RelayLimits;
  private relayId: ReplicaId | undefined;
  private readonly compactionEnabled: boolean;

  constructor(private readonly options: RelayCoreOptions) {
    this.limits = { ...DEFAULT_LIMITS, ...options.limits };
    this.compactionEnabled = options.compaction?.enabled ?? false;
  }

  get storage(): StorageAdapter {
    return this.options.storage;
  }

  get endpointId(): ReplicaId {
    if (this.relayId === undefined) throw new WeaveError('STORAGE_ERROR', 'The relay is not open');
    return this.relayId;
  }

  async open(): Promise<void> {
    await this.storage.open();
    const existing = await this.storage.transaction('ro', (tx) => tx.get(keys.metaReplica));
    if (existing !== undefined) {
      this.relayId = (JSON.parse(existing) as { replicaId: string }).replicaId;
      return;
    }
    const id = newReplicaId(this.options.random ?? platformRandom);
    await this.storage.transaction('rw', async (tx) => {
      tx.put(keys.metaReplica, JSON.stringify({ replicaId: id }));
      tx.put(STATE_KEY, JSON.stringify({ vector: {}, commit: 0 }));
      tx.put(COMPACTED_KEY, JSON.stringify({ compactedThrough: {}, removed: {} }));
    });
    this.relayId = id;
  }

  close(): Promise<void> {
    return this.storage.close();
  }

  /** The relay's own durable holdings. */
  vector(): Promise<VersionVector> {
    return this.storage.transaction('ro', async (tx) => (await readState(tx)).vector);
  }

  /** What a member has confirmed holding (design 10.3). */
  memberAck(id: ReplicaId): Promise<VersionVector | undefined> {
    return this.storage.transaction('ro', async (tx) => (await readMember(tx, id))?.ackVector);
  }

  private register(id: ReplicaId): Promise<void> {
    return this.storage.transaction('rw', async (tx) => {
      if ((await readMember(tx, id)) === undefined)
        tx.put(keys.peer(id), JSON.stringify({ ackVector: {} }));
    });
  }

  /** The horizon of compaction: for each origin, the min of member acks capped by relay vector. */
  async horizon(): Promise<VersionVector> {
    const [state, compaction, members] = await this.storage.transaction('ro', async (tx) => {
      const s = await readState(tx);
      const c = await readCompaction(tx);
      const members = new Map<ReplicaId, VersionVector>();
      const cursor = await tx.scan(keys.peerPrefix);
      for (const [k, v] of cursor) {
        const id = k.substring(keys.peerPrefix.length);
        members.set(id, (JSON.parse(v) as MemberEntry).ackVector);
      }
      return [s, c, members];
    });
    return computeHorizon(state.vector, members, compaction.removed);
  }

  /** Current compaction state. */
  async compactionInfo(): Promise<{
    horizon: VersionVector;
    compactedThrough: VersionVector;
    removed: Record<ReplicaId, number>;
  }> {
    const [state, compaction, members] = await this.storage.transaction('ro', async (tx) => {
      const s = await readState(tx);
      const c = await readCompaction(tx);
      const members = new Map<ReplicaId, VersionVector>();
      const cursor = await tx.scan(keys.peerPrefix);
      for (const [k, v] of cursor) {
        const id = k.substring(keys.peerPrefix.length);
        members.set(id, (JSON.parse(v) as MemberEntry).ackVector);
      }
      return [s, c, members];
    });
    const horizon = computeHorizon(state.vector, members, compaction.removed);
    return {
      horizon,
      compactedThrough: compaction.compactedThrough,
      removed: { ...compaction.removed },
    };
  }

  /** Perform compaction: delete ops <= horizon and advance compactedThrough. */
  async compact(): Promise<{ removedOps: number; compactedThrough: VersionVector }> {
    if (!this.compactionEnabled) {
      throw new WeaveError('NOT_SUPPORTED', 'Compaction is disabled');
    }

    // Through the push queue, so no push runs between reading the horizon and deleting; the commit
    // counter rises so a push that read the state earlier retries instead of trusting stale reads.
    return this.queue.run(() => this.compactLocked());
  }

  private async compactLocked(): Promise<{ removedOps: number; compactedThrough: VersionVector }> {
    const result = await this.storage.transaction('rw', async (tx) => {
      const state = await readState(tx);
      const compaction = await readCompaction(tx);
      const members = new Map<ReplicaId, VersionVector>();
      const cursor = await tx.scan(keys.peerPrefix);
      for (const [k, v] of cursor) {
        const id = k.substring(keys.peerPrefix.length);
        members.set(id, (JSON.parse(v) as MemberEntry).ackVector);
      }

      const horizon = computeHorizon(state.vector, members, compaction.removed);
      let removedOps = 0;

      // Scan all op keys and delete those <= horizon
      const opCursor = await tx.scan('op/');
      for (const [key] of opCursor) {
        const match = key.match(/^op\/([^/]+)\/(\d+)$/);
        if (match && match[1] && match[2]) {
          const origin = match[1];
          const seq = parseInt(match[2], 10);
          const horizonSeq = horizon[origin] ?? 0;
          if (seq <= horizonSeq) {
            tx.delete(key);
            removedOps++;
          }
        }
      }

      // Update compactedThrough
      const newCompactedThrough: Record<string, number> = { ...compaction.compactedThrough };
      for (const [origin, horizonSeq] of Object.entries(horizon)) {
        const existing = newCompactedThrough[origin] ?? 0;
        if (horizonSeq > existing) {
          newCompactedThrough[origin] = horizonSeq;
        }
      }
      const normalizedCompactedThrough = normalizeVector(newCompactedThrough);

      tx.put(
        COMPACTED_KEY,
        JSON.stringify({
          compactedThrough: normalizedCompactedThrough,
          removed: compaction.removed,
        }),
      );
      if (removedOps > 0)
        tx.put(
          STATE_KEY,
          JSON.stringify({ ...state, commit: state.commit + 1 } satisfies RelayState),
        );

      return { removedOps, compactedThrough: normalizedCompactedThrough };
    });

    return result;
  }

  async pull(request: PullRequest): Promise<PullResponse> {
    await this.register(request.replicaId); // membership before any data is returned (R3.6)
    const [vector, compaction] = await this.storage.transaction('ro', async (tx) => {
      const s = await readState(tx);
      const c = await readCompaction(tx);
      return [s.vector, c];
    });

    const selected = await selectReadablePrefix({
      senderVector: vector,
      peerVector: request.vector,
      support: request.support,
      limit: Math.min(Math.max(0, request.limit), this.limits.maxOpsPerPull),
      direction: 'pull',
      ...(request.origins === undefined ? {} : { origins: request.origins }),
      read: (origin, after, limit) =>
        this.storage.transaction('ro', async (tx) => {
          const rows = await tx.scan(keys.opPrefix(origin), {
            after: keys.op(origin, after),
            limit,
          });
          return rows.map(([, line]) => {
            // Only the envelope is read, for the prefix rule (R4a.6).
            const env = readEnvelope(line);
            return {
              seq: env.seq,
              collection: env.collection,
              schemaVersion: env.schemaVersion,
              line,
            };
          });
        }),
    });

    // Check for NEEDS_SNAPSHOT: if puller is behind compactedThrough for any origin they'd receive
    if (request.limit > 0) {
      const wanted = request.origins === undefined ? undefined : new Set(request.origins);
      for (const origin of Object.keys(vector)) {
        if (wanted !== undefined && !wanted.has(origin)) continue;
        if (vector[origin]! > (request.vector[origin] ?? 0)) {
          const compacted = compaction.compactedThrough[origin] ?? 0;
          if ((request.vector[origin] ?? 0) < compacted) {
            throw new WeaveError('NEEDS_SNAPSHOT', 'History has been compacted for this origin', {
              details: { origin, compactedThrough: compacted },
            });
          }
        }
      }
    }

    return {
      endpointId: this.endpointId,
      durable: vector,
      support: '*',
      ops: selected.lines,
      blocked: selected.blocked,
      more: selected.more,
      compaction: {
        horizon: await this.horizon(),
        compactedThrough: compaction.compactedThrough,
        removed: { ...compaction.removed },
      },
    };
  }

  push(request: PushRequest): Promise<PushResponse> {
    const run = () => this.pushLocked(request);
    return this.options.unsafeDisableQueue === true ? run() : this.queue.run(run);
  }

  private async pushLocked(request: PushRequest): Promise<PushResponse> {
    if (request.ops.length > this.limits.maxOpsPerPush) {
      throw new WeaveError(
        'VALIDATION_FAILED',
        `A push may carry at most ${this.limits.maxOpsPerPush} ops`,
      );
    }
    await this.register(request.replicaId);

    // Phase A1: verify every line; any failure rejects the whole push.
    const verified = [];
    for (const line of request.ops)
      verified.push({ line, op: await verifyOpLine(line, { maxOpBytes: this.limits.maxOpBytes }) });

    // Phase A3: conflict scan, collapse, existing check.
    const byId = new Map<string, (typeof verified)[number]>();
    for (const v of verified) {
      const key = `${v.op.replicaId}:${v.op.seq}`;
      const prior = byId.get(key);
      if (prior !== undefined && prior.op.hash !== v.op.hash)
        throw integrity(v.op.replicaId, v.op.seq);
      if (prior === undefined) byId.set(key, v);
    }
    const { state, stored, compaction } = await this.storage.transaction('ro', async (tx) => {
      const s = await readState(tx);
      const c = await readCompaction(tx);
      const m = new Map<string, string | undefined>();
      for (const [key, v] of byId) m.set(key, await tx.get(keys.op(v.op.replicaId, v.op.seq)));
      return { state: s, stored: m, compaction: c };
    });
    // [ADV] A removed member may not push at all (R3.10).
    if (compaction.removed[request.replicaId] !== undefined) {
      throw new WeaveError('PEER_REMOVED', 'This peer has been removed', {
        details: { replicaId: request.replicaId, removedAt: compaction.removed[request.replicaId] },
      });
    }
    for (const [key, v] of byId) {
      const line = stored.get(key);
      if (line !== undefined && readEnvelope(line).hash !== v.op.hash)
        throw integrity(v.op.replicaId, v.op.seq);
    }

    // Contiguity per origin. No pending buffer: ops beyond a gap are not stored; `need` is returned.
    const vector: Record<string, number> = { ...state.vector };
    const accepted: Array<(typeof verified)[number]> = [];
    const need: Record<ReplicaId, number> = {};
    const byOrigin = new Map<string, Array<(typeof verified)[number]>>();
    for (const v of byId.values())
      byOrigin.set(v.op.replicaId, [...(byOrigin.get(v.op.replicaId) ?? []), v]);
    for (const [origin, items] of byOrigin) {
      items.sort((a, b) => a.op.seq - b.op.seq);
      let next = (vector[origin] ?? 0) + 1;
      for (const v of items) {
        if (v.op.seq < next) continue; // duplicate
        if (v.op.seq > next) {
          need[origin] = next;
          break;
        }
        accepted.push(v);
        next++;
      }
      if (next - 1 > (vector[origin] ?? 0)) vector[origin] = next - 1;
    }

    // Acknowledgement of the pusher: highest pushed seq it holds that the relay now holds too.
    const pushedPrefix: Record<string, number> = {};
    for (const [origin, items] of byOrigin) {
      const top = Math.max(
        0,
        ...items.map((i) => i.op.seq).filter((s) => s <= (vector[origin] ?? 0)),
      );
      if (top > 0) pushedPrefix[origin] = top;
    }

    const nextState: RelayState = { vector: normalizeVector(vector), commit: state.commit + 1 };

    // [ADV] Ops a removed member wrote after its removal are refused, whoever relays them (R3.10).
    for (const v of accepted) {
      const removedAt = compaction.removed[v.op.replicaId];
      if (removedAt !== undefined && v.op.seq > removedAt) {
        throw new WeaveError('PEER_REMOVED', 'Ops from a removed peer are not allowed', {
          details: { replicaId: v.op.replicaId, seq: v.op.seq, removedAt },
        });
      }
    }

    await this.storage.transaction('rw', async (tx) => {
      if (this.options.unsafeDisableRecheck !== true) {
        const current = await readState(tx);
        if (current.commit !== state.commit)
          throw new WeaveError('STORAGE_CONFLICT', 'The relay changed during the push');
        for (const v of accepted) {
          const line = await tx.get(keys.op(v.op.replicaId, v.op.seq));
          if (line !== undefined && readEnvelope(line).hash !== v.op.hash)
            throw integrity(v.op.replicaId, v.op.seq);
          if (line !== undefined)
            throw new WeaveError('STORAGE_CONFLICT', 'An op was stored concurrently');
        }
      }
      for (const v of accepted) tx.put(keys.op(v.op.replicaId, v.op.seq), v.line);
      tx.put(STATE_KEY, JSON.stringify(nextState));
      const member = (await readMember(tx, request.replicaId)) ?? { ackVector: {} };
      tx.put(
        keys.peer(request.replicaId),
        JSON.stringify({ ackVector: mergeVectors(member.ackVector, pushedPrefix) }),
      );
    });
    return { durable: nextState.vector, rejected: [], need, blocked: [] };
  }

  async ack(request: AckRequest): Promise<void> {
    await this.storage.transaction('rw', async (tx) => {
      const member = (await readMember(tx, request.replicaId)) ?? { ackVector: {} };
      tx.put(
        keys.peer(request.replicaId),
        JSON.stringify({ ackVector: mergeVectors(member.ackVector, request.durable) }),
      );
    });
  }

  /** Mark a peer as removed. Idempotent: first value kept. */
  async removePeer(id: ReplicaId): Promise<void> {
    await this.storage.transaction('rw', async (tx) => {
      const compaction = await readCompaction(tx);
      const currentRelayVector = (await readState(tx)).vector;

      // First value kept (idempotent)
      if (compaction.removed[id] === undefined) {
        const lastSeq = currentRelayVector[id] ?? 0;
        tx.put(
          COMPACTED_KEY,
          JSON.stringify({
            compactedThrough: compaction.compactedThrough,
            removed: { ...compaction.removed, [id]: lastSeq },
          }),
        );
      }
    });
  }
}

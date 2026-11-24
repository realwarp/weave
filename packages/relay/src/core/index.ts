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
}

interface RelayState {
  readonly vector: VersionVector;
  readonly commit: number;
}

interface MemberEntry {
  readonly ackVector: VersionVector;
}

const STATE_KEY = 'meta/relay';

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

  constructor(private readonly options: RelayCoreOptions) {
    this.limits = { ...DEFAULT_LIMITS, ...options.limits };
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

  async pull(request: PullRequest): Promise<PullResponse> {
    await this.register(request.replicaId); // membership before any data is returned (R3.6)
    const vector = await this.vector();
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
    return {
      endpointId: this.endpointId,
      durable: vector,
      support: '*',
      ops: selected.lines,
      blocked: selected.blocked,
      more: selected.more,
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
    const { state, stored } = await this.storage.transaction('ro', async (tx) => {
      const s = await readState(tx);
      const m = new Map<string, string | undefined>();
      for (const [key, v] of byId) m.set(key, await tx.get(keys.op(v.op.replicaId, v.op.seq)));
      return { state: s, stored: m };
    });
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
}

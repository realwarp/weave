/**
 * A tiny in-memory REFERENCE endpoint that implements the protocol semantics of design 8.1 and 10.2
 * without any application knowledge: contiguous per-origin storage, duplicates ignored, gaps
 * reported through `need`, schema-aware prefix selection for pulls, monotone acknowledgements.
 * It verifies every op line like the relay does. Used to test transports in isolation.
 */
import {
  mergeVectors,
  newReplicaId,
  platformRandom,
  readEnvelope,
  selectReadablePrefix,
  verifyOpLine,
  WeaveError,
  type AckRequest,
  type OpEnvelope,
  type PullRequest,
  type PullResponse,
  type PushRequest,
  type PushResponse,
  type ReplicaId,
  type SyncEndpoint,
  type VersionVector,
} from '@weave/core/protocol';

export class ReferenceEndpoint implements SyncEndpoint {
  readonly endpointId: ReplicaId;
  private readonly lines = new Map<ReplicaId, OpEnvelope[]>();
  readonly acks = new Map<ReplicaId, VersionVector>();

  constructor(endpointId: ReplicaId = newReplicaId(platformRandom)) {
    this.endpointId = endpointId;
  }

  vector(): VersionVector {
    const v: Record<string, number> = {};
    for (const [origin, ops] of this.lines) if (ops.length > 0) v[origin] = ops.length;
    return v;
  }

  async pull(request: PullRequest): Promise<PullResponse> {
    const selected = await selectReadablePrefix({
      senderVector: this.vector(),
      peerVector: request.vector,
      support: request.support,
      limit: request.limit,
      direction: 'pull',
      ...(request.origins === undefined ? {} : { origins: request.origins }),
      read: (origin, after, limit) =>
        Promise.resolve((this.lines.get(origin) ?? []).slice(after, after + limit)),
    });
    return {
      endpointId: this.endpointId,
      durable: this.vector(),
      support: '*',
      ops: selected.lines,
      blocked: selected.blocked,
      more: selected.more,
    };
  }

  async push(request: PushRequest): Promise<PushResponse> {
    // Validate the whole push first: any bad line rejects everything (design 7.3, 10.2).
    const verified = [];
    for (const line of request.ops) verified.push({ line, op: await verifyOpLine(line) });
    const byOrigin = new Map<ReplicaId, typeof verified>();
    for (const v of verified)
      byOrigin.set(v.op.replicaId, [...(byOrigin.get(v.op.replicaId) ?? []), v]);
    const need: Record<ReplicaId, number> = {};
    for (const [origin, items] of byOrigin) {
      items.sort((a, b) => a.op.seq - b.op.seq);
      const stored = this.lines.get(origin) ?? [];
      for (const { line, op } of items) {
        const existing = stored[op.seq - 1];
        if (existing !== undefined) {
          if (readEnvelope(existing.line).hash !== op.hash) {
            throw new WeaveError('INTEGRITY_CONFLICT', 'Same op ID with different content', {
              details: { origin, seq: op.seq },
            });
          }
          continue;
        }
        if (op.seq !== stored.length + 1) {
          need[origin] = stored.length + 1;
          break;
        }
        stored.push({
          seq: op.seq,
          collection: op.collection,
          schemaVersion: op.schemaVersion,
          line,
        });
      }
      this.lines.set(origin, stored);
    }
    const ack = mergeVectors(this.acks.get(request.replicaId) ?? {}, this.pushedPrefix(byOrigin));
    this.acks.set(request.replicaId, ack);
    return { durable: this.vector(), rejected: [], need, blocked: [] };
  }

  async ack(request: AckRequest): Promise<void> {
    this.acks.set(
      request.replicaId,
      mergeVectors(this.acks.get(request.replicaId) ?? {}, request.durable),
    );
  }

  private pushedPrefix(byOrigin: Map<ReplicaId, Array<{ op: { seq: number } }>>): VersionVector {
    const v: Record<string, number> = {};
    for (const [origin, items] of byOrigin) {
      const held = this.lines.get(origin)?.length ?? 0;
      const top = Math.max(0, ...items.map((i) => i.op.seq).filter((s) => s <= held));
      if (top > 0) v[origin] = top;
    }
    return v;
  }
}

/**
 * Causal and total order (D3, D4). No transitivity or causal delivery is assumed: causality is
 * read directly from each op's full context.
 */
import { compareUtf8 } from '../canonical/encode.js';
import type { OpId, ReplicaId, VersionVector } from '../contracts/json.js';

export interface OrderKey {
  readonly lamport: number;
  readonly replicaId: ReplicaId;
  readonly seq: number;
}

export interface CausalOp extends OrderKey {
  readonly context: VersionVector;
}

/** D4: ascending `(lamport, replicaId by UTF-8 bytes, seq)`. */
export function compareD4(a: OrderKey, b: OrderKey): number {
  if (a.lamport !== b.lamport) return a.lamport < b.lamport ? -1 : 1;
  const r = compareUtf8(a.replicaId, b.replicaId);
  if (r !== 0) return r;
  if (a.seq !== b.seq) return a.seq < b.seq ? -1 : 1;
  return 0;
}

export function sameOp(a: OpId, b: OpId): boolean {
  return a.replicaId === b.replicaId && a.seq === b.seq;
}

/** D3: A happens-before B when A's ID is covered by B's context. */
export function happensBefore(a: OpId, b: { readonly context: VersionVector }): boolean {
  return (b.context[a.replicaId] ?? 0) >= a.seq;
}

/** Neither happens before the other, and they are different ops. */
export function isConcurrent(a: CausalOp, b: CausalOp): boolean {
  if (sameOp(a, b)) return false;
  return !happensBefore(a, b) && !happensBefore(b, a);
}

/** `"replicaId:seq"`, a stable string form of an op ID. */
export function opIdKey(id: OpId): string {
  return `${id.replicaId}:${id.seq}`;
}

export function toOpId(op: OpId): OpId {
  return { replicaId: op.replicaId, seq: op.seq };
}

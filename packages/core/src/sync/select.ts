/**
 * Schema-aware prefix selection (R4.10, design 8.3). Used by every sender (replica endpoint,
 * sync push loop and relay pull). For each origin it emits ops in ascending `seq` until the first
 * op the receiver cannot read; that origin is then BLOCKED and later ops are never skipped to,
 * even when they belong to a supported collection. Other origins are unaffected.
 */
import type { ReplicaId, VersionVector } from '../contracts/json.js';
import type { BlockedOrigin, Support } from '../contracts/sync.js';

export interface OpEnvelope {
  readonly seq: number;
  readonly collection: string;
  readonly schemaVersion: number;
  readonly line: string;
}

/** The receiver can read the op: collection supported at this version or newer. */
export function isSupported(
  envelope: Pick<OpEnvelope, 'collection' | 'schemaVersion'>,
  support: Support | '*',
): boolean {
  if (support === '*') return true;
  const version = support[envelope.collection];
  return version !== undefined && envelope.schemaVersion <= version;
}

/** Reads the ops of one origin with `seq > afterSeq`, ascending, at most `limit` of them. */
export type ReadOrigin = (
  origin: ReplicaId,
  afterSeq: number,
  limit: number,
) => Promise<readonly OpEnvelope[]>;

export interface SelectInput {
  /** Origins the sender holds beyond the peer, with the sender's vector. */
  readonly senderVector: VersionVector;
  /** What the receiver already holds (its accepted or durable vector). */
  readonly peerVector: VersionVector;
  readonly support: Support | '*';
  /** Maximum number of ops to emit. `0` emits nothing and only reports `more` and `blocked`. */
  readonly limit: number;
  readonly origins?: readonly ReplicaId[];
  readonly direction: 'pull' | 'push';
  readonly read: ReadOrigin;
}

export interface SelectOutput {
  /** Op lines grouped by origin (sorted origins), ascending `seq` within an origin. */
  readonly lines: string[];
  readonly perOrigin: ReadonlyArray<{ readonly origin: ReplicaId; readonly lines: string[] }>;
  readonly blocked: BlockedOrigin[];
  /** True when the receiver could still be sent more readable ops. */
  readonly more: boolean;
}

/**
 * Selects the readable prefix of every origin that the sender holds beyond the peer.
 * `origins` restricts selection; origins are processed in sorted order.
 */
export async function selectReadablePrefix(input: SelectInput): Promise<SelectOutput> {
  const filter = input.origins === undefined ? undefined : new Set(input.origins);
  const origins = Object.keys(input.senderVector)
    .filter((o) => (input.senderVector[o] ?? 0) > (input.peerVector[o] ?? 0))
    .filter((o) => filter === undefined || filter.has(o))
    .sort();
  const lines: string[] = [];
  const perOrigin: Array<{ origin: ReplicaId; lines: string[] }> = [];
  const blocked: BlockedOrigin[] = [];
  let budget = Math.max(0, input.limit);
  let more = false;

  for (const origin of origins) {
    const after = input.peerVector[origin] ?? 0;
    // Look one op past the budget so that `more` and blocking are reported exactly.
    const envelopes = await input.read(origin, after, budget + 1);
    const taken: string[] = [];
    let expected = after + 1;
    for (const env of envelopes) {
      if (env.seq !== expected) break; // the sender itself has a gap: stop (never skip)
      if (!isSupported(env, input.support)) {
        blocked.push({
          origin,
          seq: env.seq,
          collection: env.collection,
          requiredVersion: env.schemaVersion,
          direction: input.direction,
        });
        break;
      }
      if (budget === 0) {
        more = true;
        break;
      }
      taken.push(env.line);
      budget -= 1;
      expected += 1;
    }
    if (taken.length > 0) {
      lines.push(...taken);
      perOrigin.push({ origin, lines: taken });
    }
  }
  return { lines, perOrigin, blocked, more };
}

/**
 * Pure variant for already-loaded envelopes (used by tests and small in-memory endpoints).
 * `opsByOrigin[o]` must hold the sender's ops of origin `o` in ascending `seq`.
 */
export function selectFromLoaded(
  opsByOrigin: Readonly<Record<ReplicaId, readonly OpEnvelope[]>>,
  input: Omit<SelectInput, 'read' | 'senderVector'>,
): Promise<SelectOutput> {
  const senderVector: Record<ReplicaId, number> = {};
  for (const [origin, ops] of Object.entries(opsByOrigin)) {
    const last = ops[ops.length - 1];
    if (last !== undefined) senderVector[origin] = last.seq;
  }
  return selectReadablePrefix({
    ...input,
    senderVector,
    read: (origin, afterSeq, limit) =>
      Promise.resolve((opsByOrigin[origin] ?? []).filter((e) => e.seq > afterSeq).slice(0, limit)),
  });
}

/**
 * Schema-aware prefix selection (R4.10, design 8.3).
 * Used by every sender (replica endpoint, sync push loop and relay pull).
 * For each origin it emits ops in ascending `seq` until the first op the receiver cannot read;
 * that origin is then BLOCKED and later ops are never skipped to, even when they belong to a
 * supported collection. Other origins are unaffected.
 */
import type { ReplicaId, VersionVector } from '../contracts/json.js';
import type { BlockedOrigin, Support } from '../contracts/sync.js';

/** An envelope containing an op with its metadata for selection. */
export interface OpEnvelope {
  /** The sequence number of this op. */
  readonly seq: number;
  /** The collection name. */
  readonly collection: string;
  /** The schema version at which this op was written. */
  readonly schemaVersion: number;
  /** The canonical JSON line of the op. */
  readonly line: string;
}

/**
 * Checks if the receiver can read an op based on collection support.
 * @param envelope - The op envelope to check.
 * @param support - The support mapping or '*' for all.
 * @returns True if the collection is supported at this version or newer.
 */
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

/** Input for the selectReadablePrefix function. */
export interface SelectInput {
  /** Origins the sender holds beyond the peer, with the sender's vector. */
  readonly senderVector: VersionVector;
  /** What the receiver already holds (its accepted or durable vector). */
  readonly peerVector: VersionVector;
  /** What collections and versions the receiver supports. */
  readonly support: Support | '*';
  /** Maximum number of ops to emit. `0` emits nothing and only reports `more` and `blocked`. */
  readonly limit: number;
  /** Optional filter to select only specific origins. */
  readonly origins?: readonly ReplicaId[];
  /** The sync direction: 'pull' from relay, 'push' to relay. */
  readonly direction: 'pull' | 'push';
  /** Function to read ops from an origin. */
  readonly read: ReadOrigin;
}

/** Output of the selectReadablePrefix function. */
export interface SelectOutput {
  /** Op lines grouped by origin (sorted origins), ascending `seq` within an origin. */
  readonly lines: string[];
  /** Op lines grouped by origin. */
  readonly perOrigin: ReadonlyArray<{
    /** The origin replica. */
    readonly origin: ReplicaId;
    /** That origin's selected op lines, ascending seq. */
    readonly lines: string[];
  }>;
  /** Origins stopped at their first op the receiver cannot read (schema too new). */
  readonly blocked: BlockedOrigin[];
  /** True when the receiver could still be sent more readable ops (budget was exhausted). */
  readonly more: boolean;
}

/**
 * Selects the readable prefix of every origin that the sender holds beyond the peer.
 * @param input - The select input configuration.
 * @returns A Promise that resolves with the selected ops grouped by origin.
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
 * Pure variant of selectReadablePrefix for already-loaded envelopes (used by tests and small in-memory endpoints).
 * `opsByOrigin[o]` must hold the sender's ops of origin `o` in ascending `seq`.
 * @param opsByOrigin - Ops grouped by origin, each array sorted by seq ascending.
 * @param input - Select input excluding the read function and senderVector.
 * @returns A Promise that resolves with the selected ops.
 * @internal The read function filters ops after afterSeq and slices to limit.
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

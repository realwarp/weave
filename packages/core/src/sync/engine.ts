/**
 * The sync engine (design 8.2, R4.1 to R4.7, R4.10).
 *
 * Each round: pull until nothing more is readable (per-origin isolation after a rejected batch),
 * acknowledge what was committed, push the ops the endpoint lacks (ONE origin per request), then a
 * stable double read: L_start, a `limit: 0` pull for the endpoint's durable vector E, L_end.
 * `complete` only when E == L_start == L_end with nothing blocked or rejected.
 */
import type { ReplicaId, VersionVector } from '../contracts/json.js';
import { WeaveError, type ErrorCode } from '../contracts/errors.js';
import type { SyncHost } from '../contracts/replica.js';
import type {
  BlockedOrigin,
  PeerEntry,
  PullResponse,
  RejectedOrigin,
  Support,
  SyncEndpoint,
  SyncOptions,
  SyncResult,
} from '../contracts/sync.js';
import { readEnvelope } from '../ops/op.js';
import { mergeVectors, vectorsEqual } from '../ops/vector.js';
import { INVALID_DATA_CODES } from './ban.js';
import { selectReadablePrefix } from './select.js';
import { DEFAULT_RETRY_POLICY, withRetry } from './retry.js';

const DEFAULT_MAX_ROUNDS = 5;
const DEFAULT_BATCH = 500;
const MAX_LOOP = 10_000;

/** Errors that quarantine an origin instead of failing the whole sync (design 7.3). */
const ORIGIN_ERRORS: readonly ErrorCode[] = [
  'VALIDATION_FAILED',
  'UNSUPPORTED_VALUE',
  'INTEGRITY_CONFLICT',
  'NOT_SUPPORTED',
  'MIGRATION_FAILED',
  'PEER_REMOVED',
  'UNAUTHORIZED', // [ADV] R16.3, R16.4: one denied origin never blocks the others
];

function isOriginError(e: unknown): e is WeaveError {
  return e instanceof WeaveError && ORIGIN_ERRORS.includes(e.code);
}

function originsOf(lines: readonly string[]): string[] {
  return [...new Set(lines.map((l) => readEnvelope(l).replicaId))].sort();
}

export async function runSync(
  host: SyncHost,
  endpoint: SyncEndpoint,
  options: SyncOptions = {},
): Promise<SyncResult> {
  const maxRounds = Math.max(1, options.maxRounds ?? DEFAULT_MAX_ROUNDS);
  const batch = Math.max(1, options.batchSize ?? DEFAULT_BATCH);
  const support: Support = host.support();
  const retry = <T>(fn: () => Promise<T>): Promise<T> =>
    withRetry(fn, DEFAULT_RETRY_POLICY, {
      random: host.random,
      scheduler: host.scheduler,
      onRetry: (e) =>
        host.emit({ type: 'retry', attempt: e.attempt, delayMs: e.delayMs, code: e.code }),
    });

  const counts = { rounds: 0, pulled: 0, pushed: 0, duplicates: 0, promoted: 0 };
  const rejected = new Map<string, RejectedOrigin>();
  let peerId: ReplicaId | null = null;
  let peerSupport: Support | '*' = {};
  let endpointDurable: VersionVector = {};
  let lastE: VersionVector = {};
  let lastL: VersionVector = {};
  let lastStable = false;

  host.setState('syncing');
  host.emit({ type: 'sync.start', peer: null });

  const pull = (
    vector: VersionVector,
    limit: number,
    origins?: readonly string[],
  ): Promise<PullResponse> =>
    retry(() =>
      endpoint.pull({
        replicaId: host.replicaId,
        vector,
        support,
        limit,
        ...(origins === undefined ? {} : { origins }),
        ...(host.holdsNewer?.() === true ? { hold: true } : {}),
      }),
    ).then(async (res) => {
      // [ADV] Learn the relay's horizon and removed list (R3.6, R3.10).
      if (res.compaction !== undefined && host.noteCompaction !== undefined)
        await host.noteCompaction(res.compaction);
      return res;
    });

  const noteEndpoint = (res: PullResponse): void => {
    // [ADV] R10.5: nothing from a banned endpoint is applied; the sync fails with PEER_BANNED.
    host.assertPeerAllowed?.(res.endpointId);
    peerId = res.endpointId;
    peerSupport = res.support;
    endpointDurable = mergeVectors(endpointDurable, res.durable);
  };

  const applyPulled = async (lines: readonly string[]): Promise<void> => {
    try {
      const r = await host.applyIncoming(lines, peerId ?? 'unknown');
      counts.duplicates += r.duplicates;
      counts.promoted += r.promoted;
    } catch (e) {
      if (!isOriginError(e)) throw e;
      // Isolation: repeat the pull once per origin; each per-origin batch is atomic.
      for (const origin of originsOf(lines)) {
        if (rejected.has(origin)) continue;
        try {
          const res = await pull(await host.readVector(), batch, [origin]);
          noteEndpoint(res);
          if (res.ops.length === 0) continue;
          const r = await host.applyIncoming(res.ops, peerId ?? 'unknown');
          counts.duplicates += r.duplicates;
          counts.promoted += r.promoted;
        } catch (inner) {
          if (!isOriginError(inner)) throw inner;
          rejected.set(origin, { origin, code: inner.code, direction: 'pull' });
          host.emit({ type: 'error', code: inner.code, message: inner.message });
        }
      }
    }
  };

  /**
   * A pull that skips origins already quarantined. Without quarantined pull origins this is the
   * plain 0.1.0 pull. With them, only the other origins the endpoint holds are asked for.
   */
  const pullAllowed = async (local: VersionVector): Promise<PullResponse> => {
    const deniedPull = [...rejected.values()].some((r) => r.direction === 'pull');
    if (!deniedPull) return pull(local, batch);
    const origins = Object.keys(endpointDurable)
      .filter((o) => !rejected.has(o) && (endpointDurable[o] ?? 0) > (local[o] ?? 0))
      .sort();
    if (origins.length === 0) {
      const probe = await pull(local, 0);
      return probe;
    }
    return pull(local, batch, origins);
  };

  const isolateDeniedPull = async (local: VersionVector): Promise<void> => {
    // A vector-only pull sends no ops, so no hook runs; an identity failure still throws here.
    const probe = await pull(local, 0);
    noteEndpoint(probe);
    const origins = Object.keys(probe.durable)
      .filter((o) => !rejected.has(o) && (probe.durable[o] ?? 0) > (local[o] ?? 0))
      .sort();
    for (const origin of origins) {
      try {
        const res = await pull(await host.readVector(), batch, [origin]);
        noteEndpoint(res);
        if (res.ops.length > 0) await applyPulled(res.ops);
      } catch (e) {
        if (!isOriginError(e)) throw e;
        rejected.set(origin, { origin, code: e.code, direction: 'pull' });
        host.emit({ type: 'error', code: e.code, message: e.message });
      }
    }
  };

  let failure: WeaveError | undefined;
  const blockedPull = new Map<string, BlockedOrigin>();
  const blockedPush = new Map<string, BlockedOrigin>();

  try {
    for (let round = 1; round <= maxRounds; round++) {
      counts.rounds = round;
      blockedPull.clear();
      blockedPush.clear();

      // 1. Pull loop.
      for (let i = 0; i < MAX_LOOP; i++) {
        const local = await host.readVector();
        let res: PullResponse;
        try {
          res = await pullAllowed(local);
        } catch (e) {
          // [ADV] The endpoint's hook denied the batch (R16.4): find the origins it denies with
          // one pull per origin, quarantine those, and keep syncing the rest.
          if (!(e instanceof WeaveError) || e.code !== 'UNAUTHORIZED') throw e;
          await isolateDeniedPull(local);
          res = await pullAllowed(await host.readVector());
        }
        noteEndpoint(res);
        for (const b of res.blocked) blockedPull.set(b.origin, b);
        const lines = res.ops.filter((l) => !rejected.has(readEnvelope(l).replicaId));
        if (lines.length > 0) {
          counts.pulled += lines.length;
          host.emit({ type: 'batch.received', peer: res.endpointId, count: lines.length });
          await applyPulled(lines);
        }
        const after = await host.readVector();
        const progressed = !vectorsEqual(after, local);
        // Acknowledge only what is durably committed (R3.5).
        if (progressed)
          await retry(() => endpoint.ack({ replicaId: host.replicaId, durable: after }));
        if (!res.more || !progressed) break;
      }

      // 2. Push loop: one origin per request.
      const local = await host.readVector();
      for (const origin of Object.keys(local).sort()) {
        if (rejected.has(origin)) continue;
        for (let i = 0; i < MAX_LOOP; i++) {
          const peerHas = endpointDurable[origin] ?? 0;
          if ((local[origin] ?? 0) <= peerHas) break;
          const selected = await selectReadablePrefix({
            senderVector: { [origin]: local[origin] ?? 0 },
            peerVector: { [origin]: peerHas },
            support: peerSupport,
            limit: batch,
            direction: 'push',
            read: (o, after, limit) => host.readOps(o, after, limit),
          });
          for (const b of selected.blocked) blockedPush.set(b.origin, b);
          if (selected.lines.length === 0) break;
          let res;
          try {
            // [ADV] R16.4: this replica's own hook decides before ops leave.
            await host.authorizeSend?.(peerId ?? 'unknown', selected.lines);
            res = await retry(() =>
              endpoint.push({ replicaId: host.replicaId, support, ops: selected.lines }),
            );
          } catch (e) {
            if (!isOriginError(e)) throw e;
            rejected.set(origin, { origin, code: e.code, direction: 'push' });
            host.emit({ type: 'error', code: e.code, message: e.message });
            break;
          }
          counts.pushed += selected.lines.length;
          host.emit({
            type: 'batch.sent',
            peer: peerId ?? 'unknown',
            origin,
            count: selected.lines.length,
          });
          for (const b of res.blocked) blockedPush.set(b.origin, b);
          const before = peerHas;
          endpointDurable = mergeVectors(endpointDurable, res.durable);
          const needAt = res.need[origin];
          if (needAt !== undefined && needAt - 1 < (endpointDurable[origin] ?? 0)) {
            endpointDurable = { ...endpointDurable, [origin]: needAt - 1 };
          }
          if ((endpointDurable[origin] ?? 0) <= before && needAt === undefined) break; // no progress
          if (res.blocked.some((b) => b.origin === origin)) break;
        }
      }

      // 3. Verification: a stable double read.
      const lStart = await host.readVector();
      const verify = await pull(lStart, 0);
      noteEndpoint(verify);
      const e = verify.durable;
      const lEnd = await host.readVector();
      endpointDurable = mergeVectors(endpointDurable, e);
      for (const b of verify.blocked) blockedPull.set(b.origin, b);
      lastE = e;
      lastL = lEnd;
      const stable = vectorsEqual(e, lStart) && vectorsEqual(lStart, lEnd);
      lastStable = stable;
      if (rejected.size > 0 || blockedPull.size > 0 || blockedPush.size > 0) break;
      if (stable) break;
    }
  } catch (e) {
    failure =
      e instanceof WeaveError ? e : new WeaveError('TRANSPORT_ERROR', 'Sync failed', { cause: e });
  }

  // [ADV] R10.5: a sync in which the endpoint sent invalid data is one strike against it.
  // Rejections of what WE pushed, schema mismatch and authorization are not strikes.
  if (
    peerId !== null &&
    [...rejected.values()].some(
      (r) => r.direction === 'pull' && INVALID_DATA_CODES.includes(r.code),
    )
  )
    host.notePeerInvalid?.(peerId);

  const blocked = [...blockedPull.values(), ...blockedPush.values()];
  let result: SyncResult;
  if (failure !== undefined || rejected.size > 0) {
    const error =
      failure ??
      new WeaveError(rejected.values().next().value!.code, 'One or more origins were rejected', {
        details: { rejectedOrigins: [...rejected.values()] },
      });
    result = {
      ...counts,
      status: 'failed',
      code: error.code,
      error,
      blocked,
      rejectedOrigins: [...rejected.values()],
    };
  } else if (blocked.length > 0) {
    result = {
      ...counts,
      status: 'partial',
      code: 'PEER_SCHEMA_OLDER',
      blocked: blocked as [BlockedOrigin, ...BlockedOrigin[]],
      rejectedOrigins: [],
    };
  } else if (!lastStable) {
    result = {
      ...counts,
      status: 'partial',
      code: 'NOT_SETTLED',
      blocked: [],
      rejectedOrigins: [],
      endpoint: lastE,
      local: lastL,
    };
  } else {
    result = { ...counts, status: 'complete', settled: lastL, blocked: [], rejectedOrigins: [] };
  }

  if (peerId !== null) {
    const previous: PeerEntry = (await host.readPeer(peerId)) ?? { ackVector: {}, support: {} };
    const entry: PeerEntry = {
      ...previous,
      ackVector: mergeVectors(previous.ackVector, endpointDurable),
      support: peerSupport,
      lastResult: result,
      ...(result.status === 'complete' ? { lastSyncWall: host.clock.nowMs() } : {}),
    };
    await host.writePeer(peerId, entry);
  }
  host.setState(result.status === 'failed' ? 'failed' : 'idle');
  if (result.status === 'failed')
    host.emit({ type: 'error', code: result.code, message: result.error.message });
  return result;
}

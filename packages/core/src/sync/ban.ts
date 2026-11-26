/**
 * [ADV] Peer ban (R10.5, task T5.7). A peer that repeatedly sends invalid data is refused for a
 * configurable period. Time comes only from the injected monotonic `Scheduler`, never from wall
 * time, so tests drive it with the fake scheduler and clock changes cannot lift or extend a ban.
 *
 * - A strike is one request (or one sync) whose data this replica rejected as invalid: one of
 *   `INVALID_DATA_CODES`. Schema mismatch (`SCHEMA_TOO_NEW`, `NOT_SUPPORTED`), authorization
 *   (`UNAUTHORIZED`), removal and transport errors are not strikes: they are not invalid data.
 * - `threshold` strikes within `windowMs` ban the peer for `banMs`. A strike counts while it is
 *   less than `windowMs` old; one exactly `windowMs` old no longer counts (ADR-0015). When the
 *   ban ends the peer starts again with no strikes.
 * - The book is in memory: a restart lifts every ban (monotonic time has no meaning across
 *   processes). Valid peers are never affected: bans are per peer ID.
 */
import { WeaveError, type ErrorCode } from '../contracts/errors.js';
import type { ReplicaId } from '../contracts/json.js';
import type { BanOptions, BanStatus } from '../contracts/replica.js';

/** Error codes that mean the peer sent invalid data (design 7.3). */
export const INVALID_DATA_CODES: readonly ErrorCode[] = [
  'VALIDATION_FAILED',
  'UNSUPPORTED_VALUE',
  'INTEGRITY_CONFLICT',
  'MIGRATION_FAILED',
];

/** Default ban settings: 3 strikes within 1 minute ban the peer for 5 minutes. */
export const DEFAULT_BAN = { threshold: 3, windowMs: 60_000, banMs: 300_000 } as const;

/** Whether an error counts as a strike. */
export function isInvalidData(e: unknown): e is WeaveError {
  return e instanceof WeaveError && INVALID_DATA_CODES.includes(e.code);
}

function positiveInt(v: unknown, name: string): number {
  if (!Number.isSafeInteger(v) || (v as number) < 1)
    throw new WeaveError('VALIDATION_FAILED', `ban.${name} must be a positive integer`, {
      details: { [name]: v },
    });
  return v as number;
}

/** Validates ban options and fills in the defaults. */
export function resolveBanOptions(options: BanOptions): Required<Omit<BanOptions, 'enabled'>> {
  return {
    threshold: positiveInt(options.threshold ?? DEFAULT_BAN.threshold, 'threshold'),
    windowMs: positiveInt(options.windowMs ?? DEFAULT_BAN.windowMs, 'windowMs'),
    banMs: positiveInt(options.banMs ?? DEFAULT_BAN.banMs, 'banMs'),
  };
}

/** Per-peer strikes and bans, against one monotonic time source. */
export class BanBook {
  private readonly strikes = new Map<ReplicaId, number[]>();
  private readonly bans = new Map<ReplicaId, number>();
  private readonly settings: Required<Omit<BanOptions, 'enabled'>>;

  constructor(
    options: BanOptions,
    private readonly now: () => number,
  ) {
    this.settings = resolveBanOptions(options);
  }

  /** Remaining ban time of `peer` in ms, or 0. An expired ban is dropped here. */
  remainingMs(peer: ReplicaId): number {
    const until = this.bans.get(peer);
    if (until === undefined) return 0;
    const left = until - this.now();
    if (left > 0) return left;
    this.bans.delete(peer);
    this.strikes.delete(peer);
    return 0;
  }

  /**
   * Refuses a banned peer before anything is read or written.
   * @throws PEER_BANNED with the remaining time.
   */
  assertNotBanned(peer: ReplicaId): void {
    const left = this.remainingMs(peer);
    if (left > 0)
      throw new WeaveError('PEER_BANNED', `Peer ${peer} is banned for sending invalid data`, {
        details: { peer, remainingMs: left },
      });
  }

  /** Records one strike; returns true when it starts a ban. Strikes of a banned peer are ignored. */
  strike(peer: ReplicaId): boolean {
    if (this.remainingMs(peer) > 0) return false;
    const now = this.now();
    const recent = (this.strikes.get(peer) ?? []).filter((t) => now - t < this.settings.windowMs);
    recent.push(now);
    if (recent.length >= this.settings.threshold) {
      this.strikes.delete(peer);
      this.bans.set(peer, now + this.settings.banMs);
      return true;
    }
    this.strikes.set(peer, recent);
    return false;
  }

  /** The current bans, sorted by peer ID. Empty when none. */
  status(): BanStatus[] {
    const out: BanStatus[] = [];
    for (const peer of [...this.bans.keys()].sort()) {
      const remainingMs = this.remainingMs(peer);
      if (remainingMs > 0) out.push({ peer, remainingMs });
    }
    return out;
  }
}

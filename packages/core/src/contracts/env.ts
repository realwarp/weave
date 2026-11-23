/**
 * Injected environment (design 2, 7.1). The engine never reads the wall clock or platform
 * randomness directly (A5, R10.2); everything goes through these small interfaces.
 */

/** Source of randomness. `randomBytes` is the only primitive; see `randomFloat` for floats. */
export interface Random {
  randomBytes(length: number): Uint8Array;
}

/** Wall-clock source. Used ONLY for display values such as `wallTime` and `lastSyncWall` (A5). */
export interface Clock {
  /** Milliseconds since the Unix epoch. */
  nowMs(): number;
}

/** Monotonic timer and sleeping. Used only for retry backoff, never for stored data (R10.2). */
export interface Scheduler {
  /** Monotonic milliseconds from an arbitrary origin. */
  monotonicMs(): number;
  sleep(ms: number): Promise<void>;
}

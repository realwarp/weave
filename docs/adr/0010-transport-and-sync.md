# ADR-0010: Transport as `SyncEndpoint`, retry and backoff, verified sync point

Status: accepted. Requirements: R4, R10.2, R10.3, design 8.

## Context

Replicas sync with each other directly, through a relay, in-process in tests, or over HTTP. The
network drops, duplicates and delays messages. A sync must say honestly whether the two sides now
hold the same ops, even while other devices keep writing.

## Options

1. A transport API per medium, with sync logic inside each transport.
2. One small interface, `SyncEndpoint { pull, push, ack }`, implemented by replicas, the relay and
   transports, with all sync logic in the engine.

## Decision

Option 2.

- **Endpoint.** `pull` returns the ops beyond the caller's vector that it can read, plus the
  endpoint's durable vector and any blocked origins; `limit: 0` is a pure vector exchange. `push`
  sends one origin per request. `ack` reports what the caller committed. Transports forward calls
  unchanged and treat op lines as opaque.
- **Retry.** Retryable failures (timeouts, dropped connections, HTTP 5xx and 429) are retried with
  exponential backoff and full jitter: `delay = random * min(cap, base * 2^n)`, defaults 6 attempts,
  base 250 ms, cap 30 s. `Random` and `Scheduler` are injected, so tests assert exact delays.
  Non-retryable errors (401, WEAVE validation codes) stop at once.
- **Verified sync point.** After pulling and pushing, the engine reads its own vector (`L_start`),
  asks the endpoint for its durable vector with a `limit: 0` pull (`E`), and reads its own vector
  again (`L_end`). The sync is `complete` only when `E == L_start == L_end`. Otherwise it runs
  another round, and after `maxRounds` returns `partial` / `NOT_SETTLED` with everything committed
  kept. `SyncResult` is a discriminated union: `complete`, `partial` (`PEER_SCHEMA_OLDER` or
  `NOT_SETTLED`) or `failed` with `rejectedOrigins`.
- `lastSyncWall` (display only) is updated only by a `complete` sync.

## Consequences

- One conformance suite covers the reference endpoint, in-process and HTTP transports, and the
  real relay.
- `complete` is a real guarantee at that moment, not "no error happened".
- WebSocket and direct network transports are [ADV] and not implemented.

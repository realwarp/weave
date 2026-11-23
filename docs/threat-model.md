# Threat model

Scope: the MVP packages (`@weave/core`, `@weave/storage`, `@weave/transport`, `@weave/relay`) and
the two applications. Requirements R16.1 to R16.6; design section 11.

## What WEAVE protects

- **Integrity of shared history.** Every op is immutable and carries a SHA-256 hash over the
  canonical encoding of its full payload. Replicas and the relay recompute it on receipt.
- **Convergence.** State is a pure function of the accepted op set, so honest replicas that hold
  the same ops hold the same state, whatever the arrival order or wall clocks.
- **Durability of acknowledged data.** An op is acknowledged only after it is committed.
- **Availability of a shared relay** against oversized or malformed input.

## Actors

| Actor                          | Trust                                                              |
| ------------------------------ | ------------------------------------------------------------------ |
| Application user on a device   | Trusted for their own device's data                                |
| Peer replica                   | Trusted to follow the protocol; its input is still fully validated |
| Relay operator                 | Trusted to run the relay and keep its token and data directory     |
| Network attacker               | Untrusted; can read, drop, delay, replay or modify traffic         |
| Local user with disk access    | Out of scope (see known limits)                                    |

## Threats and defenses

| Threat                                     | Defense                                                                                                                     | Where                                     |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| Corrupted or altered op                    | Hash recomputed over the full payload; canonical-form check; whole batch rejected                                         | `verifyOpLine`, `applyIncoming`, `RelayCore.push` |
| Oversized or hostile payload               | Op size (64 KiB), depth, ops per push and pull (500), request body (4 MiB, HTTP 413), strict structure, D7 value whitelist | `verifyOpLine`, relay server              |
| Same op ID with different content          | `INTEGRITY_CONFLICT` (`REPLICA_ID_REUSE`); the first stored version stays byte-identical                                  | engine, relay (queue plus in-transaction re-check) |
| Replay or duplicate delivery               | Idempotent: an op already held is ignored and acknowledged again                                                          | engine, relay                             |
| Retried user action creating a duplicate   | Required caller-supplied `mutationId`, stored with the result                                                             | write path (R5.4)                         |
| Invalid data from one origin               | Per-origin isolation: that origin is rejected and reported in `rejectedOrigins`; others still sync                       | sync engine (R4.7)                        |
| Unauthorized relay access                  | Optional bearer token (`WEAVE_RELAY_TOKEN`), constant-time comparison, HTTP 401                                           | relay server (R4a.9)                      |
| Secrets in logs                            | The token is never logged; request logs hold method, route, status and duration only; events carry IDs and counts, not field values | relay server, engine logger         |
| Accidental data corruption at rest         | Journal header checks and SHA-256 trailers, snapshot checksums; a torn tail is cut only when provably incomplete          | file adapter (design 9.1)                 |
| Two processes writing one data directory   | Exclusive `LOCK`; takeover only when the holder is provably dead on the same host, boot and PID namespace                 | file adapter                              |
| Dependency vulnerabilities                 | Zero runtime dependencies; `npm audit --omit=dev` and `npm audit` in CI                                                    | CI (R16.6)                                |

## The relay token

- Set `WEAVE_RELAY_TOKEN` in the relay's environment. Clients pass it to
  `httpTransport({ baseUrl, token })`, which sends `Authorization: Bearer <token>`.
- With no token set, the relay accepts every request. It binds to `127.0.0.1` by default, so an
  open relay is reachable only from the same machine unless `--host` says otherwise.
- `GET /v1/health` needs no token and returns only `ok` and the relay ID.
- The token is one shared secret. It controls access to the relay; it does not identify users.
- Run the relay behind TLS (a reverse proxy) whenever it is reachable over a network: the token
  and all op content travel in clear text otherwise.

## Known limits

These are not defended in the MVP. They are stated so that applications can decide.

- **No encryption in transit** beyond TLS placed in front of the relay. Direct in-process sync has
  no network layer.
- **No per-user authorization.** Any client with the token can read every op on the relay and push
  ops for any origin.
- **Claimed identity.** A sender can claim another replica's ID. Authenticated identity and an
  authorization hook are [ADV] (R16.3, R16.4) and not implemented.
- **Origin stall.** A peer can stop one origin from propagating by sending invalid data for it. The
  origin is quarantined and reported; other origins keep syncing (design 7.3).
- **`wallTime` is unauthenticated.** It is display information only and is not covered by the
  hash; ordering never reads it.
- **Acknowledgement over-claim.** The relay records what a member says it holds; it cannot verify
  the claim. A malicious or buggy member can over-claim. In the MVP this changes no data, because
  nothing is deleted based on acknowledgements.
- **Compaction trust assumption ([ADV], not implemented).** Compaction would remove ops that every
  registered member has acknowledged. It assumes members follow the acknowledgement protocol:
  they ack only after durable storage and never claim more than they hold. It is not safe against
  a member that over-claims (design 10.3; ADR-0006 is written in task T4.1).
- **Local tampering.** Checksums detect accidental corruption. They do not stop a local user who can
  rewrite the data directory.

## Dependency audit

Recorded 2026-11-24: `npm audit --omit=dev` reports **0 vulnerabilities**. No package ships a
runtime dependency outside the `@weave/*` workspace, so the production tree has nothing to audit.
Development tools (TypeScript, Vitest, ESLint, Vite, Playwright) are checked by `npm audit` in CI.

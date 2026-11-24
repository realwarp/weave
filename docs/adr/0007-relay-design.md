# ADR-0007: Relay design: durable ack-after-commit, acknowledgement rules, opaque store-and-forward

Status: accepted. Requirements: R4a, design 10.

## Context

Devices are rarely online at the same time. They need a peer that is usually reachable, keeps ops
safely, and does not become a second application server that must know every schema.

## Options

1. A server that applies schemas and resolves conflicts (server-authoritative).
2. A message queue with time-based retention.
3. An opaque, durable store-and-forward peer that speaks the same protocol as replicas.

## Decision

Option 3, in `@weave/relay`.

- **Opaque.** The relay verifies each op's structure, value rules, canonical form and hash, and
  stores the line byte for byte. It never imports resolvers, schemas or migrations; it reads only
  the envelope (ID, collection, schema version, context) for routing and schema-aware delivery.
  A boundary test enforces this.
- **Durable before acknowledge.** A push is validated whole, committed in one transaction, and only
  then answered. A crash before the commit stores nothing; a crash after it loses only the response,
  and the retry is an idempotent duplicate.
- **One version per op ID.** Pushes run through one in-process queue, and the commit transaction
  re-checks identity. Tests disable each in turn to show that either alone prevents a second stored
  version.
- **Acknowledgement rules.** A member's ack vector rises only by (a) its own `AckRequest`, sent
  after it committed what it pulled, or (b) the validated, stored prefix of what it pushed. A pull
  never raises it. Repeated and out-of-order acks never lower it. Acks survive restarts.
- **Wire format.** HTTP: `POST /v1/pull` (JSON in, NDJSON out), `POST /v1/push` (NDJSON in, JSON
  out), `POST /v1/ack` (JSON), `GET /v1/health`. Op lines travel unchanged, one per NDJSON line.
  Every request field is validated; bodies are capped at 4 MiB. An optional bearer token is compared
  in constant time and never logged. The relay binds to `127.0.0.1` by default.

## Consequences

- Any replica can stand in for the relay; tests run the same conformance suite against both.
- The relay cannot reject application-invalid data; receiving replicas reject that origin
  (per-origin isolation, ADR-0008).
- The ack record is a claim, not proof (see the trust assumption in ADR-0006).

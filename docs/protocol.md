# Sync protocol (sketch)

One interface serves relays and replicas (`SyncEndpoint`, `packages/core/src/contracts/sync.ts`):

| Call | Request | Response |
|---|---|---|
| `pull` | the puller's accepted vector, its supported schema versions, a limit (0 = vector exchange only), optional origins | the endpoint's durable vector, op lines, blocked origins, `more` |
| `push` | the sender's supported versions and op lines of ONE origin | the endpoint's durable vector, schema rejections, `need` (gaps), blocked origins |
| `ack` | the requester's durable accepted vector (sent after it committed what it received) | none |

## Sync round (`replica.sync`)

1. Pull until `more` is false. Each batch is applied atomically; then `ack`.
2. Push, one origin per request, in `seq` order.
3. **Verify:** read `L_start`, pull with `limit: 0` to get the endpoint's vector `E`, read `L_end`.
   `complete` only if `E == L_start == L_end` and nothing is blocked or rejected. Otherwise repeat,
   up to `maxRounds`, then `partial` / `NOT_SETTLED`.

## Schema-aware delivery

The sender gives each origin only the contiguous prefix the receiver can read. At the first
unreadable op it stops that origin and never skips ahead. The result is `partial` /
`PEER_SCHEMA_OLDER` with the blocked origins.

## Relay HTTP (NDJSON)

`POST /v1/pull`, `POST /v1/push`, `POST /v1/ack`, `GET /v1/health`. Op lists are one canonical JSON
op per line. Optional bearer token from `WEAVE_RELAY_TOKEN`.

Opt-in 0.2.0 routes: `GET` and `PUT /v1/snapshot`, `POST /v1/admin/compact` and
`POST /v1/admin/remove-peer`. Details in the [relay README](../packages/relay/README.md).

## WebSocket (0.2.0)

The same three calls, one JSON text message each, between two replicas with no relay in between
(`@weave/transport/websocket` and `@weave/transport/websocket/server`). See the
[transport README](../packages/transport/README.md).

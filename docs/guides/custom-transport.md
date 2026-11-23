# Custom transport

A transport carries the sync protocol between a replica and an endpoint. It implements
`SyncEndpoint` from `@weave/core/protocol` and forwards each call unchanged.

## The interface

```ts
interface SyncEndpoint {
  pull(request: PullRequest): Promise<PullResponse>;
  push(request: PushRequest): Promise<PushResponse>;
  ack(request: AckRequest): Promise<void>;
}
```

- `pull({ replicaId, vector, support, limit, origins? })` returns the ops beyond `vector` that the
  caller can read, as canonical op lines, plus the endpoint's `durable` vector. `limit: 0` is a pure
  vector exchange; the sync engine uses it to check that both sides hold the same ops.
- `push({ replicaId, support, ops })` sends op lines. The engine sends one origin per request. The
  response has the endpoint's `durable` vector, `need` (the first missing `seq` per origin) and any
  rejections.
- `ack({ replicaId, durable })` reports what the caller has committed after a pull.

Op lines are opaque strings to a transport. Never parse, re-encode or reorder them: the endpoint
checks their hashes and canonical form.

## Errors

Throw a `WeaveError` with code `TRANSPORT_ERROR`. Set `retryable: true` for timeouts, dropped
connections, HTTP 5xx and 429; set it to `false` for authentication failures and other permanent
errors. When the remote side returns a WEAVE error code (for example `INTEGRITY_CONFLICT`), throw
that code so the sync engine can react to it.

## Conformance

```ts
import { runTransportConformance } from '@weave/testing';

runTransportConformance('my transport', async () => {
  const server = await startTestRelay();
  return { endpoint: myTransport({ url: server.url }), close: server.close };
});
```

The factory returns a fresh, empty endpoint as seen through the transport. The suite uses real,
hashed ops, so it also runs against the relay.

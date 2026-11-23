# Custom transport

A transport adapts WEAVE's sync protocol to a specific network protocol. The core sends and receives batches of ops using a `SyncEndpoint` interface.

## SyncEndpoint interface

```ts
interface SyncEndpoint {
  pull(request: {
    fromVector: VersionVector;
    support: Record<string, number> | '*';
    maxRounds: number;
  }): Promise<{
    status: 'complete' | 'partial' | 'failed';
    ops: Op[];
    ackVector: VersionVector;
  }>;

  push(request: {
    ops: Op[];
    support: Record<string, number> | '*';
  }): Promise<{
    status: 'complete' | 'partial' | 'failed';
    rejectedOrigins?: { origin: string; code: string }[];
    promoted?: number;
  }>;

  ack(request: {
    ackVector: VersionVector;
  }): Promise<void>;
}
```

## What `vector` versus `durable` mean

- `vector`: the version vector a party claims to hold. This is **advisory** and not verified cryptographically.
- `durable`: the version vector that has been written to durable storage. This is the **authoritative** truth.

The sync protocol verifies a "stable double read" to ensure the durable vectors match before declaring a sync complete.

## One origin per push

The push loop sends **one origin's ops per request**. If a batch from origin X is rejected, the entire batch is discarded, and the next push from X is retried. Origins whose batches fail are listed in `rejectedOrigins`.

## Limit 0

If `limit: 0` is specified, no ops are transferred. This is used for the final verification round to confirm both parties hold the same ops.

## Error mapping and retryable

Errors are classified as:

- **Retryable:** network transient, temporary overload
- **Non-retryable:** permanent failure (e.g., auth error, unsupported schema)

The sync engine retries retryable errors with exponential backoff up to a configurable max.

Run the conformance suite:

```ts
import { runTransportConformance } from '@weave/testing';
import { MyTransportEndpoint } from './my-transport';

const endpoint = () => new MyTransportEndpoint();
runTransportConformance(endpoint);
```

The suite verifies:

- Batch transfer (ops are received exactly once)
- Idempotency (duplicate ops are handled correctly)
- Error handling (rejection propagates to `rejectedOrigins`)
- Vector exchange (version vectors are accurate)
- Schema-aware delivery (ops beyond supported schema are blocked)
# @weave/transport

Transports carry the WEAVE sync protocol between a replica and an endpoint. Each returns a
`SyncEndpoint` to pass to `replica.sync(...)`.

| Entry point                    | Function                                              |
| ------------------------------ | ----------------------------------------------------- |
| `@weave/transport/in-process`  | `inProcessTransport(endpoint)`                        |
| `@weave/transport/http`        | `httpTransport({ baseUrl, token?, fetch?, timeoutMs? })` |
| `@weave/transport/websocket`   | `websocketTransport({ url, token?, timeoutMs?, WebSocket? })` (0.2.0) |
| `@weave/transport/websocket/server` | `serveWebSocket({ endpoint, token?, authenticate?, path?, host?, port?, maxMessageBytes?, log? })` (0.2.0, Node.js) |

```ts
import { httpTransport } from '@weave/transport/http';

const result = await replica.sync(httpTransport({ baseUrl: 'http://127.0.0.1:8787', token }));
```

## HTTP

Talks to `weave-relay` (`@weave/relay`): `POST /v1/pull`, `/v1/push`, `/v1/ack`. Op lines travel
unchanged as NDJSON. With `token`, every request carries `Authorization: Bearer <token>`.

Errors are `WeaveError` with code `TRANSPORT_ERROR`. Timeouts, dropped connections, HTTP 5xx and
429 are `retryable: true` and the sync engine retries them with backoff; 401 and other 4xx are not
retryable. A WEAVE error code from the relay (for example `INTEGRITY_CONFLICT`) is passed through.
`encodePullResponse`, `decodePullResponse`, `encodePushRequest` and `decodePushRequest` are exported
for servers.

## WebSocket (0.2.0)

Direct network sync between two replicas, with no relay in between. One side serves its endpoint;
the other syncs through it.

```ts
import { serveWebSocket } from '@weave/transport/websocket/server';
import { websocketTransport } from '@weave/transport/websocket';

// Device A (Node.js): binds 127.0.0.1 and a free port unless host and port are given.
const server = await serveWebSocket({ endpoint: a.endpoint(), token });

// Device B (Node.js 22 or a browser): uses the platform WebSocket.
const ws = websocketTransport({ url: server.url, token });
const result = await b.sync(ws);
ws.close();
await server.close();
```

- **Protocol.** The same `pull`, `push` and `ack` calls as HTTP, one JSON text message each, on
  path `/v1/ws` by default. Op lines travel unchanged. One connection is opened on first use and
  reused; several requests can be in flight on it.
- **Errors.** A failed handshake, a lost connection and a timeout (default 30 s, including
  connecting) are retryable `TRANSPORT_ERROR`s; the next call reconnects. Endpoint errors keep
  their WEAVE code. With no `WebSocket` available, `websocketTransport` throws `NOT_SUPPORTED`.
- **Secrets.** The secret travels in the WebSocket subprotocol, because browsers cannot set
  headers, and is never logged. `token` is a shared secret that gives no identity. For per-caller
  identity, pass `authenticate(secret)` and an endpoint function, for example
  `endpoint: (auth) => replica.endpoint({ auth })`.
- **Bounds.** Messages above `maxMessageBytes` (default 16 MiB) are refused before they are
  buffered, and at most 64 requests can be in flight per connection.
- **Limits.** No TLS: put `wss://` termination in front across networks. No connection cap and no
  idle timeout: across networks, run it behind a proxy that limits both. The relay has no
  WebSocket route; use HTTP for the relay. Details: ADR-0015.

## In-process

Wraps an endpoint (another replica's `replica.endpoint()`, or a `RelayCore`) and copies requests
and responses, as a network would. Used in tests and for same-process sync.

## Writing your own

See [the custom transport guide](../../docs/guides/custom-transport.md) and run
`runTransportConformance` from `@weave/testing`. Design notes:
[ADR-0010](../../docs/adr/0010-transport-and-sync.md).

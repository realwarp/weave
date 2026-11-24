# @weave/transport

Transports carry the WEAVE sync protocol between a replica and an endpoint. Each returns a
`SyncEndpoint` to pass to `replica.sync(...)`.

| Entry point                    | Function                                              |
| ------------------------------ | ----------------------------------------------------- |
| `@weave/transport/in-process`  | `inProcessTransport(endpoint)`                        |
| `@weave/transport/http`        | `httpTransport({ baseUrl, token?, fetch?, timeoutMs? })` |

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

## In-process

Wraps an endpoint (another replica's `replica.endpoint()`, or a `RelayCore`) and copies requests
and responses, as a network would. Used in tests and for same-process sync.

## Writing your own

See [the custom transport guide](../../docs/guides/custom-transport.md) and run
`runTransportConformance` from `@weave/testing`. Design notes:
[ADR-0010](../../docs/adr/0010-transport-and-sync.md).

# @weave/relay

A small, durable store-and-forward peer for WEAVE replicas. The relay verifies and stores op lines
byte for byte, but it never reads field values, applies schemas, runs migrations or resolves
conflicts. Replicas sync with it exactly as they sync with each other.

## Run

```sh
weave-relay --data ./relay-data --port 8787 [--host 127.0.0.1]
```

| Setting | Flag     | Environment         | Default        |
| ------- | -------- | ------------------- | -------------- |
| Data    | `--data` | `WEAVE_RELAY_DATA`  | `./relay-data` |
| Port    | `--port` | `WEAVE_RELAY_PORT`  | `8787`         |
| Host    | `--host` | `WEAVE_RELAY_HOST`  | `127.0.0.1`    |
| Token   | none     | `WEAVE_RELAY_TOKEN` | no token       |

When `WEAVE_RELAY_TOKEN` is set, every data route needs `Authorization: Bearer <token>`. The token is
compared in constant time and is never logged. The relay binds to `127.0.0.1` unless you pass
another host. `SIGINT` and `SIGTERM` close the server and the data directory cleanly. On Windows,
where a parent process cannot deliver `SIGTERM`, send the IPC message `'shutdown'` instead (the
convention process managers use). A relay that is killed outright leaves its lock behind; on
Windows and macOS, follow `docs/guides/storage-recovery.md` before restarting it.

## Routes

| Route            | Request | Response              |
| ---------------- | ------- | --------------------- |
| `POST /v1/pull`  | JSON    | NDJSON                |
| `POST /v1/push`  | NDJSON  | JSON                  |
| `POST /v1/ack`   | JSON    | `204`                 |
| `GET /v1/health` | none    | `{ ok, endpointId }`  |

Limits: 4 MiB per request body (`413` above it), 500 ops per push, 500 ops per pull, 64 KiB per op.
A push is all or nothing: one invalid or conflicting line rejects the whole request.

## Library

```ts
import { startRelay } from '@weave/relay';

const relay = await startRelay({ dir: './relay-data', port: 8787, token: process.env.TOKEN });
// ... later
await relay.close();
```

`RelayCore`, `createRelayServer` and `listen` are exported for custom hosting.

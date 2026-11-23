# WEAVE

An offline-first application foundation.

Independent devices and records → exchanged changes → reconciled shared state.

WEAVE is a reusable TypeScript library for offline-first applications. Each device keeps working
with no connection and records every change as an immutable, hash-protected operation. Devices
exchange those operations later, directly or through a relay, and end up with the same state.
State is a pure function of the accepted operation set, so arrival order and wall clocks never
change the result.

## Install

Node.js 22 or later.

```sh
npm ci
npm run build
npm test
```

## Quick start

```ts
import { createReplica, defineCollection, f } from '@weave/core';
import { memoryStorage } from '@weave/storage/memory';

const notes = defineCollection({
  name: 'notes',
  version: 1,
  fields: {
    title: f.string({ required: true }),
    tags: f.set(f.string()),
    status: f.rank(['open', 'done']),
  },
});

const a = await createReplica({ storage: memoryStorage(), collections: [notes] });
const b = await createReplica({ storage: memoryStorage(), collections: [notes] });

// One mutationId per user intent: store it with the intent and reuse it on every retry.
const { recordId } = await a
  .collection(notes)
  .create({ title: 'Fix the gate', tags: ['urgent'], status: 'open' }, { mutationId: a.newMutationId() });

const result = await b.sync(a.endpoint());
console.log(result.status); // 'complete'
console.log((await b.collection(notes).get(recordId))?.value.title); // 'Fix the gate'
console.log(JSON.stringify(await a.hashes()) === JSON.stringify(await b.hashes())); // true
```

To sync through a relay instead, start `weave-relay --data ./relay-data --port 8787` and pass
`httpTransport({ baseUrl: 'http://127.0.0.1:8787' })` from `@weave/transport/http` to `sync`.

## How it works

- **Operation log.** Every write becomes one immutable op with a SHA-256 hash over its canonical
  encoding.
- **Version vectors.** Replicas exchange exactly the ops the other side lacks.
- **Deterministic resolvers.** Concurrent edits to one field merge by fixed rules
  (`last-writer-wins` by Lamport order, `max`, `min`, `set-union`, `max-rank`). Conflicts stay
  visible through `replica.conflicts`.
- **Schema versions.** Old ops are upgraded on read; a peer never receives ops it cannot read.
- **Adapters.** Storage (memory, file, IndexedDB) and transport (in-process, HTTP) are pluggable.

See `docs/architecture.md` and `docs/adr/`.

## Packages

| Package                                         | Contents                                                   |
| ----------------------------------------------- | ---------------------------------------------------------- |
| [`@weave/core`](packages/core/README.md)        | Engine, schema, resolvers, canonical encoding, sync engine |
| [`@weave/storage`](packages/storage/README.md)  | Memory, file (Node.js) and IndexedDB (browser) adapters    |
| [`@weave/transport`](packages/transport/README.md) | In-process and HTTP client transports                   |
| [`@weave/relay`](packages/relay/README.md)      | Store-and-forward relay server and `weave-relay` CLI       |
| [`@weave/testing`](packages/testing/README.md)  | Conformance suites, simulator, fault injection (dev only)  |

API reference: `npm run docs:api` writes it to `docs/api/`.

## Demo applications

Both use only WEAVE's public API. [How they differ](docs/app-differences.md).

- [GHOSTLINE](apps/ghostline/README.md): community coordination. Announcements, help requests
  that people claim and tag, and a notices panel. `npm run dev:ghostline`, `npm run demo:ghostline`.
- [FIELDNOTE](apps/fieldnote/README.md): field inspections. Observations with severity, an
  inspection status workflow, a v1 to v2 schema migration and a conflict history view.
  `npm run dev:fieldnote`, `npm run demo:fieldnote`.

The demos start a real relay process and print every device's hashes at the end. A recording
script is in [docs/demo-plan.md](docs/demo-plan.md).

## Status

Built and tested: the core engine, memory, file and IndexedDB storage (IndexedDB in Chromium), both
transports, the relay, the simulator, both applications, and the property, scenario, fuzz,
browser, relay end-to-end and benchmark suites. See [CHANGELOG.md](CHANGELOG.md).

Not implemented ([ADV] features): compaction and `removePeer`, snapshot bootstrap, `restore` and
`update-wins`, the counter resolver and custom resolvers, holding newer-schema ops, the
authorization hook and authenticated identity, peer bans, the WebSocket transport and direct
network sync, and the GHOSTLINE "me too" counter.

## Guides

- [Custom storage adapter](docs/guides/custom-storage.md)
- [Custom transport](docs/guides/custom-transport.md)
- [Custom resolvers](docs/guides/custom-resolver.md)
- [Migrations](docs/guides/migrations.md)
- [Storage recovery](docs/guides/storage-recovery.md)

## Project documents

- [Architecture](docs/architecture.md), [protocol](docs/protocol.md) and the
  [decision records](docs/adr/)
- [Threat model](docs/threat-model.md)
- [How this project was built with Kiro Crew](docs/kiro-crew.md)
- [Disclosure](docs/disclosure.md): no prior code, the parent-repository situation, third-party tools
- Review reports for each gate: [docs/reviews/](docs/reviews/)

## License

MIT. See [LICENSE](LICENSE).

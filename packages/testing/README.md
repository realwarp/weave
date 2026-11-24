# @weave/testing

Test tooling for WEAVE and for people who write adapters or apps on it. Development only: the
package is private and is not published.

| Export                                     | Use                                                              |
| ------------------------------------------ | ---------------------------------------------------------------- |
| `runStorageConformance(name, factory)`     | The storage suite every adapter must pass                        |
| `crashingStorage(adapter)`                 | Fails at a chosen write or transaction, before or after commit   |
| `runTransportConformance(name, factory)`   | The transport and endpoint suite, with real hashed ops           |
| `ReferenceEndpoint`, `makeOps`             | A simple opaque endpoint and a builder of valid op lines         |
| `FaultyEndpoint(endpoint, rates)`          | Seeded drops, duplicates, reorders and truncation                |
| `seededRandom(seed)`                       | Deterministic `Random` (SplitMix64)                              |
| `fakeClock()`, `fakeScheduler()`           | Time that moves only when told; instant, recorded sleeps         |
| `createSimulator(options)`                 | Runs real replicas: writes, syncs in random pairs, offline, upgrades |
| `arbJsonValue`, `arbOpPayload`, `arbBatches`, ... | fast-check generators                                     |

```ts
import { runStorageConformance } from '@weave/testing';

runStorageConformance('my adapter', async () => ({ adapter: myAdapter(), reopen: async () => myAdapter() }));
```

The simulator is driven by one seed: the same seed gives the same history, op bytes and hashes,
so a failing property run can be reproduced exactly (`WEAVE_PROPERTY_SEEDS=<seed>`).

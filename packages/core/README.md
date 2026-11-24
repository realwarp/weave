# @weave/core

WEAVE core: operation log, canonical encoding, state derivation, sync engine.

Part of the WEAVE monorepo. See the root README and `docs/`.

## Test coverage

Measured on 2026-11-24 with `@vitest/coverage-v8` over `packages/core/src/**` (frozen contracts
excluded), 154 tests passing:

```sh
npx vitest run packages/core --coverage.enabled --coverage.include=packages/core/src/** --coverage.exclude=packages/core/src/contracts/**
```

| Area (owner)                         | Statements | Branches | Functions |
| ------------------------------------ | ---------: | -------: | --------: |
| `canonical` (Core engine)            |      95.4% |    88.7% |    100.0% |
| `ops` (Core engine)                  |      97.0% |    92.7% |     86.5% |
| `schema` (Core engine)               |      83.1% |    90.9% |     89.5% |
| `engine` (Core engine)               |      94.2% |    87.6% |     94.3% |
| `sync` (Synchronization)             |      90.2% |    80.8% |     88.2% |
| `resolvers` (Conflict resolution)    |     100.0% |    98.2% |    100.0% |
| `state` (Conflict resolution)        |     100.0% |    94.8% |    100.0% |
| **All of `src`**                     |  **93.8%** | **89.1%** | **93.2%** |

The cross-package suites in `tests/property` and `tests/integration` exercise the same code again
and are not counted here.

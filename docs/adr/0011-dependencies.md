# ADR-0011: Zero runtime dependencies; development tools

Status: accepted. Requirements: R11.5, R16.6.

## Decision

No shipped package has a runtime dependency (only workspace links between WEAVE packages).
Hashing uses `globalThis.crypto.subtle`, HTTP uses `node:http` and `fetch`, storage uses
`node:fs` and IndexedDB.

Development-only tools, each with one reason:

| Tool | Reason |
|---|---|
| typescript | compile, strict types |
| vitest | unit and integration tests, runs TypeScript directly |
| fast-check | property-based tests (R15.2) |
| eslint, typescript-eslint, @eslint/js | lint and determinism rules (A5) |
| prettier | formatting |
| @playwright/test | Chromium tests for IndexedDB and canonical vectors (R15.10) |
| vite | dev server and bundling for the two apps only |
| typedoc | API documentation (R11.3) |
| tsx | run TypeScript scripts and demos |
| @types/node | Node type declarations |

## Consequences

`npm audit --omit=dev` has nothing to report. Adding a runtime dependency needs a new ADR.

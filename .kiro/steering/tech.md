# Technical rules

## Stack

TypeScript 5 (`strict`, `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`), ESM only,
Node.js 22, npm workspaces, Vitest, fast-check, ESLint, Prettier, Playwright (Chromium), Vite with
vanilla TypeScript for apps. **No runtime dependencies** in any shipped package.

## Determinism rules (requirement A5, design section 2)

- Engine code never calls `Date.now`, `new Date`, `performance.now` or `Math.random`. Use the
  injected `Clock`, `Scheduler` and `Random`. ESLint and `npm run check:boundaries` enforce this.
- Wall-clock time is display information only (`wallTime`, `lastSyncWall`). Ordering, conflict
  resolution, deletion and compaction never read it.
- State is a pure function of the accepted operation set. Arrival order never matters.
- Only **accepted** ops count for `lamport`, `context`, hashes and acknowledgements. Buffered ops in
  `pend/` do not.

## Write contract (requirement R5.4)

Every `create`, `update` and `delete` takes a required, caller-supplied `mutationId`: one stable ID
per user intent, stored with the intent before the first attempt and reused on every retry.
Never generate a fresh ID inside a retry loop.

## Boundaries

- `@weave/core` imports nothing outside itself (no `node:*`, no other package).
- The relay is semantically opaque: it never imports resolvers, schemas or migrations.
- Apps import only public entry points and contain no sync, hashing or canonical-encoding code.

## Quality gates

`npm run lint`, `npm run format:check`, `npm run build`, `npm run typecheck:tests`, `npm test`,
`npm run check:boundaries`, `npm run check:license`.

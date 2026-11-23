# ADR-0012: Monorepo layout, npm workspaces and ownership

Status: accepted. Requirements: R20, R14a.1.

## Decision

- npm workspaces: `packages/*` (core, storage, transport, relay, testing) and `apps/*`
  (ghostline, fieldnote). One lockfile, Node 22 pinned in `.nvmrc`.
- TypeScript project references with `tsc --build`; ESM only; `exports` maps per package.
- `@weave/core` has two entry points: `@weave/core` (public API) and `@weave/core/protocol`
  (wire types, used by the relay and transports).
- Tests import workspace packages through Vitest aliases to source, so tests need no build.
- Apps may import only public entry points. `scripts/check-boundaries.mjs` enforces this.
- Every path has one owner (`OWNERS`, design 18.2) so parallel agents never edit the same files.

## Consequences

Boundaries are checked in CI. Contract types in `packages/core/src/contracts/**` are frozen at Gate 0.

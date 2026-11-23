# Repository structure and ownership

```
.kiro/                specs, steering, hooks
docs/                 ADRs, guides, threat model, demo plan, review reports
packages/core         engine (src/contracts is frozen after Gate 0)
packages/storage      memory, file, IndexedDB adapters
packages/transport    in-process and HTTP transports
packages/relay        relay server and CLI
packages/testing      conformance suites, simulator, fault injection (dev only)
apps/ghostline        community coordination app
apps/fieldnote        field operations app
tests/                cross-package property, integration, relay, browser tests
scripts/              CI and quality scripts
```

Every path has exactly one owner, listed in `OWNERS` and in design section 18.2. Edit only the
paths your workstream owns. Cross-package tests live in `tests/**` (Testing and QA). Changes to
`packages/core/src/contracts/**` go through the Architecture owner.

Independent review tasks are review-only: they write only `docs/reviews/<task id>.md`.

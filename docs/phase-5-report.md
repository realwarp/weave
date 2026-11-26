# Phase 5 report: the [ADV] features

Branch `feat/phase-5-advanced`. The Phase 5 work (code, tests, README and changelog) ends at
commit `3c175c7`; commit `5022b74` added this report. Starting point: `main` at the v0.1.0 merge
`5e3e5d3`. The v0.1.0 tag is unchanged (tag object `b9e10ff`, commit `4b26e91`).

## Result

All 68 tasks in `.kiro/specs/mission-build-weave-an-offline-first/tasks.md` are checked: the 59
MVP tasks released in 0.1.0 and the nine Phase 5 tasks below. Each Phase 5 task was implemented,
tested, independently reviewed by a Testing and QA agent, and marked only after an accepted
review with no open findings.

| Task | Feature | Requirement | Implementation | Accepted review | Marked |
| --- | --- | --- | --- | --- | --- |
| T5.1 | Compaction and `removePeer` | R3.6 to R3.13 | `0f8571f` | `docs/reviews/T5.1.md` | `37184e5` |
| T5.2 | Snapshot bootstrap | R4.8 | `a09c660` | `docs/reviews/T5.2.md` | `b4904a6` |
| T5.3 | `restore` and `update-wins` | R6.9, D6 | `6a11764` | `docs/reviews/T5.3.md` | `31fdb50` |
| T5.4 | Counter and custom resolvers | R6.10 | `7e4cd15` | `docs/reviews/T5.4.md` | `64687d5` |
| T5.5 | Held newer-schema ops | R8.7 | `ebf7a52`, `bb579c1`, `ffed3a7` | `docs/reviews/T5.5.md` | `42051c0` |
| T5.6 | Authorization hook, authenticated identity | R16.3, R16.4 | `44834d4`, `c1c6f44`, `df5e997`, `6b096ca` | `docs/reviews/T5.6.md` | `13a44f6` |
| T5.7 | Peer ban | R10.5 | `f8c0366`, `fd15cfa` | `docs/reviews/T5.7.md` | `5c32f20` |
| T5.8 | WebSocket transport, direct network sync | R4.4, R9.5 | `f28dbcc`, `ad09784` | `docs/reviews/T5.8.md` | `d7f50ce` |
| T5.9 | GHOSTLINE "me too" counter | R13.7 | `4f617ae`, `ffb87d3` | `docs/reviews/T5.9.md` | `6c854a7` |

Each task also has `docs/reviews/T5.x-resolution.md`, which records every review run, why any run
was rejected, the genuine findings and their fixes, and the coordinator's check of the accepted
evidence.

## Genuine defects found by review and fixed

| Task | Defect | Fix |
| --- | --- | --- |
| T5.4 | One delta check had no test of its own | Direct test of `validateLocalWrite` |
| T5.5 | Held ops entered state after an upgrade without schema validation | Validate on upgrade; invalid ops stay out of state and are reported |
| T5.5 | No test of an older endpoint that ignores `hold` | Test added |
| T5.6 | No test told the shared relay token from a device identity, or caught a replica pull under another ID | Two security tests added |
| T5.7 | The ban window boundary was undefined and untested | ADR-0015 rule, test of `N-W-1`, `N-W`, `N-W+1` |
| T5.8 | Quadratic CPU when a client drips a large frame one byte at a time (denial of service) | Linear frame parsing, timing test |
| T5.9 | The GHOSTLINE README did not mention the counter or schema version 2 | README section |

## How review evidence was verified

Several review runs were rejected and kept as `docs/reviews/T5.x-rejected-run*.md`. Their faults
were invented or contradictory test output, several mutations run together, skipped required
checks, copied evidence, and caught mutations graded as defects. From T5.7 on, every accepted
review ran a mutation harness in its own fresh worktree. The harness applies one mutation at a
time, requires it to build, saves the raw diff, build output, test output and clean-tree check,
runs every gate on the reverted tree, and writes a SHA-256 manifest of all logs. The coordinator
checked each accepted report's manifest against the files and against an independent coordinator
run of the same mutations.

The raw logs stay on the review machine and are not in the repository. In the review files,
local machine paths are written as `(local scratch directory)`, `(reviewer's own scratch
directory)` and `(repository root)`. The folder names under them (for example `t57-logs-wQyuYJ`)
and every manifest hash are unchanged.

## Original Phase 5 verification (commit `3c175c7`)

These results were recorded on `3c175c7`, before this report was added. Run in a fresh worktree
with raw logs (manifest
`1FA4391451A1D5E5A86D94144DEC72E03EC94BCB20620B176607167FBB00A2D7`):

| Gate | Result |
| --- | --- |
| Build, lint, format, test typecheck | exit 0 |
| Unit, property, scenario and integration tests | `Tests  713 passed (713)` |
| Browser tests (Chromium) | `Tests  27 passed (27)` |
| Boundary and license checks, API docs, app differences | exit 0 |
| GHOSTLINE and FIELDNOTE demos | both converge (GHOSTLINE prints `me too = 4` on all devices) |
| Playwright UI tests, both apps | 1 passed each |
| Reproducible build, benchmarks | pass (10,000 ops in 1.35 s; 1,000-op sync in 0.11 s) |
| `npm audit --omit=dev` | 0 vulnerabilities |
| GitHub Actions CI run 45436024829 | success on all six jobs (Ubuntu, Windows, macOS, browser, benchmarks, reproducible build) |

Test count over Phase 5: 551 at the start of T5.1, 713 at the end.

## Pull request verification (commit `5022b74`)

Pull request #2 (`feat/phase-5-advanced` to `main`) was opened at `5022b74`. That commit differs
from `3c175c7` only by this report. All gates were run again on `5022b74` in a fresh worktree with
raw logs (manifest `245A2EEA6B95FA491873A96A4FB96475897ED8BD58B250AE61F86121D470FD6A`):

| Gate | Result |
| --- | --- |
| Build, lint, format, test typecheck | exit 0 |
| Unit, property, scenario and integration tests | exit 0, `Tests  713 passed (713)` in 66 files |
| Browser tests (Chromium) | exit 0, `Tests  27 passed (27)` in 2 files |
| Boundary and license checks, API docs, app differences | exit 0 |
| GHOSTLINE and FIELDNOTE demos | exit 0, both converge (GHOSTLINE prints `me too = 4` on all devices) |
| Playwright UI tests, both apps | 1 passed each |
| Reproducible build | pass, both builds `6cdf4fe78be999e2ac48ab0e421ee39b61963e8d99f134a4dec4f4a26d8547da` |
| Benchmarks | pass (10,000 ops in 1.30 s; 1,000-op sync in 0.11 s) |
| `npm audit --omit=dev` | 0 vulnerabilities |
| GitHub Actions CI run 45441102303 (`pull_request`, head `5022b74`) | success on all six jobs |

The documentation cleanup committed after `5022b74` changes only files under `docs/`.

## Integration with `main` and PR #2 review fixes

`main` (PR #3 merge `5e92ea6`, the Windows file-lock recovery fix) was merged into this branch at
`abe06d0`, with no conflicts; the only file both changed is `tasks.md`, which kept both edits.
PR #3 changes only `packages/storage` lock code and tests, the spec and the recovery guide; no
Phase 5 code depends on the lock behaviour.

The automated reviews of PR #2 raised these findings. Each fix has a regression test that failed
on the previous code (captured before the fix) and fails again when the fix is reverted
(mutation harness, clean tree, logs kept outside the repository):

| ID | Finding | Fix | Regression test | Reverted fix |
| --- | --- | --- | --- | --- |
| F1 | Counter totals rounded near `MAX_SAFE_INTEGER` | exact `bigint` sum | `packages/core/test/resolvers/counter-precision.test.ts` | 3 tests fail |
| F2 | A banned endpoint's compaction data was stored before the ban check | ban checked first | `packages/core/test/sync/ban-compaction.test.ts` | 1 fails |
| F3 | A relay pull denied after its selection changed left an empty member | undo the membership it created | `packages/relay/test/compaction/membership-races.test.ts` | 1 fails |
| F4 | Relay `removePeer` could land inside a running push | push queue and commit-counter bump | same file | queue and bump both removed: 1 fails; either one alone still passes (each closes the race) |
| F5 | Snapshot verification copied one origin's seq list per op | per-origin set, added in place | `packages/core/test/sync/snapshot-scaling.test.ts` (counts iterator steps, no timing) | 1 fails |
| F6 | Snapshot bootstrap accepted ops of an undefined collection without holding | `SCHEMA_TOO_NEW` unless holding (R4.10, R8.7) | `packages/core/test/sync/snapshot-unknown-collection.test.ts` | 1 fails |

Open: F7. Compaction deletes the `mut/` records of the ops it removes (design 7.2 and ADR-0006
say so), so a retry of such a mutation is no longer recognized. R5.4 states the idempotency
without a compaction exception. This needs a decision; nothing was changed.

Verification at `dfd1c79` (clean tree): build, lint, format, test typecheck, boundaries, license,
API docs and both demos exit 0; `Tests  753 passed (753)` in 75 files; browser
`Tests  27 passed (27)`; app differences up to date; reproducible build passed; both Playwright UI
tests 1 passed; benchmarks passed (10,000 ops in 1.55 s; 1,000-op sync 0.11 s);
`npm audit --omit=dev` 0 vulnerabilities. CI results are recorded in the pull request.

## Compatibility

Every addition is optional and off by default (ADR-0015). 0.1.0 code, adapters and transports
work unchanged, and the 0.1.0 suites pass on every Phase 5 commit. Three union types gained
values (`OpPayload.kind`, `ResolverName`, `FieldKind`); code with an exhaustive `switch` over them
must add cases. GHOSTLINE `requests` moved to schema version 2; 0.1.0 devices are told to update.
Runtime dependencies: none.

## Known limits (documented in ADR-0015 and the threat model)

- Compaction and snapshot archives trust members to follow the acknowledgement protocol.
- Peer bans are in memory, keyed by the claimed replica ID, and replica-side only.
- The WebSocket server has no connection cap, idle timeout or TLS; run it behind a proxy across
  networks. The relay has no WebSocket route.
- Authorization is per request and per origin, not per record; admin routes accept any valid
  relay secret.

## Proposed release: 0.2.0

New features with no breaking change to existing behaviour, so a minor version under Semantic
Versioning. The `[Unreleased]` section of `CHANGELOG.md` is written for it. Proposed steps, not
taken without approval:

1. Decide F7, have the fixes independently reviewed, then merge pull request #2
   (`feat/phase-5-advanced` to `main`, opened, not merged) after human approval.
2. Set `version` to `0.2.0` in the root and package `package.json` files, and date the changelog
   section.
3. Tag `v0.2.0` on that commit. The existing `v0.1.0` tag stays as it is.

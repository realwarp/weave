# Getting started

Everything needed to install WEAVE from source, run the two demonstration apps, run the tests and
start developing. All commands run from the repository root.

## Prerequisites

- **Node.js 22 or later.** The repository pins 22 in `.nvmrc` (`nvm use`, `fnm use` or similar
  pick it up). Check with `node --version`.
- **npm** (comes with Node.js) and **Git**.
- **Chromium for Playwright**, only for the browser tests: `npx playwright install chromium`
  (on Linux CI: `npx playwright install --with-deps chromium`).

WEAVE has no runtime dependencies. The development tools (TypeScript, Vitest, ESLint, Prettier,
Playwright, Vite, TypeDoc) are installed by `npm ci`.

## Install and build

```sh
git clone https://github.com/realwarp/weave.git
cd weave
npm ci
npm run build
```

`npm run build` compiles every package (`tsc --build`). The apps and the relay CLI run from the
compiled output, so build again after changing package code.

## Run the apps in a browser

```sh
npm run dev:ghostline
```

This starts a `weave-relay` process on `127.0.0.1:8787` (data in `relay-data/ghostline`) and the
app's Vite dev server on `http://127.0.0.1:5173`, which forwards `/v1/*` to the relay. Open two
windows:

- `http://127.0.0.1:5173/?device=alice`
- `http://127.0.0.1:5173/?device=bob`

Each `?device=` name is a separate device with its own IndexedDB database. Work in either window,
then press **Sync** in each to exchange changes. A new name starts a new, empty device.

FIELDNOTE works the same way:

```sh
npm run dev:fieldnote
```

Open `http://127.0.0.1:5173/?device=ana` and `?device=ben`. Add `&schema=1` to run a device on the
old schema version 1 and watch it receive only what it can read.

**Stop the app with Ctrl+C** in the terminal. This shuts the relay down cleanly. Closing the
terminal window or killing the process instead leaves the relay's lock file behind; see
[Troubleshooting](#troubleshooting).

Both apps use the same two ports by default, so run one at a time, or move the second one:

| Variable            | Default                 | Meaning                                    |
| ------------------- | ----------------------- | ------------------------------------------ |
| `GHOSTLINE_PORT`    | `5173`                  | GHOSTLINE's dev server port                |
| `FIELDNOTE_PORT`    | `5173`                  | FIELDNOTE's dev server port                |
| `WEAVE_RELAY_PORT`  | `8787`                  | The relay's port (the dev server follows it) |
| `WEAVE_RELAY_DATA`  | `relay-data/<app>`      | The relay's data directory                 |
| `WEAVE_RELAY_TOKEN` | none                    | A shared bearer token; add `&token=<token>` to the app URL |

```sh
# macOS / Linux
FIELDNOTE_PORT=5174 WEAVE_RELAY_PORT=8788 npm run dev:fieldnote
```

```powershell
# Windows PowerShell
$env:FIELDNOTE_PORT="5174"; $env:WEAVE_RELAY_PORT="8788"; npm run dev:fieldnote
```

To start with an empty relay, point `WEAVE_RELAY_DATA` at a new directory instead of deleting the
old one.

## Run the headless demos

```sh
npm run demo:ghostline
npm run demo:fieldnote
```

Each starts a real relay process and several devices on file storage, prints every step and ends
with every device's state hashes (`all hashes equal: true`). [docs/demo-plan.md](../demo-plan.md)
explains what each step shows.

## Run the tests

| Command                                          | What it runs                                                               |
| ------------------------------------------------ | -------------------------------------------------------------------------- |
| `npm test`                                       | Unit, property, fuzz, integration, crash and relay end-to-end tests (Vitest) |
| `npm run test:browser`                           | Canonical encoding and IndexedDB tests in Chromium                          |
| `npx playwright test -c apps/ghostline/test/e2e` | GHOSTLINE in a browser: two devices through a real relay                   |
| `npx playwright test -c apps/fieldnote/test/e2e` | FIELDNOTE in a browser: two workers, a conflict, a refused reading         |
| `npm run bench`                                  | Benchmarks: 10,000 ops applied in under 5 s, a 1,000-op sync in under 2 s   |
| `node scripts/repro-build.mjs`                   | Builds twice and compares the output hashes (it removes `dist`; run `npm run build` afterwards) |

Run one file or folder with `npx vitest run <path>`, for example
`npx vitest run apps/fieldnote`. The property suites use fixed seeds; to try others, set
`WEAVE_PROPERTY_SEEDS=<seed>[,<seed>...]` (the nightly CI run picks random ones and prints them).

## Development workflow

Before you push, run the same checks CI runs:

```sh
npm run lint
npm run format:check
npm run build
npm run typecheck:tests
npm test
npm run check:boundaries
node scripts/gen-differences.mjs --check
npm run docs:api
npm run check:license
npm audit --omit=dev
```

- `npm run format` fixes formatting (Prettier; Markdown is not reformatted).
- `npm run check:boundaries` enforces the package rules: `@weave/core` imports nothing outside
  itself, the relay never imports resolvers or schemas, and the apps use public entry points only.
- `node scripts/gen-differences.mjs --write` regenerates [docs/app-differences.md](../app-differences.md)
  after you change an app's `src/model.ts`.
- `npm run docs:api` builds the API reference into `docs/api/` and fails on any undocumented
  export.

See [CONTRIBUTING.md](../../CONTRIBUTING.md) for the project rules and pull request expectations.

## Troubleshooting

| Symptom                                                                 | Cause and fix                                                                                                                                                                                                                       |
| ----------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Build first: npm run build`                                            | The dev script needs the compiled relay. Run `npm run build`.                                                                                                                                                                       |
| `STORAGE_LOCKED` with `holderPid` and `reliableHostId: false`           | A relay (or file-backed replica) using that directory was killed and left its `LOCK`. On Windows and macOS WEAVE never takes such a lock over by itself. Follow the [storage recovery guide](storage-recovery.md); do not just delete the file. |
| `EADDRINUSE` on 5173 or 8787                                            | Another app or relay already uses the port (often the other demo app). Stop it with Ctrl+C, or use other ports as shown above.                                                                                                     |
| The status says "Couldn't sync" or "You're offline"                     | The relay is not reachable. Your changes are still saved on the device; start the relay and press Sync again. "Details" shows the technical error.                                                                                 |
| "Partly up to date" / "Partly shared" with `PEER_SCHEMA_OLDER`          | This device runs an older schema than some changes need. Expected for `?schema=1`; upgrade the device to receive the rest.                                                                                                        |
| Playwright: `Executable doesn't exist`                                  | Install the browser: `npx playwright install chromium`.                                                                                                                                                                            |
| `npm ci` fails with an engine or syntax error                           | Use Node.js 22 or later.                                                                                                                                                                                                            |

# FIELDNOTE

Offline-first field inspections on WEAVE: workers record inspections and observations at sites
with no signal, and every edit is merged when they reconnect. The app uses only WEAVE's public API;
it contains no sync, hashing or encoding code.

## Run it

```sh
npm ci && npm run build
npm run dev:fieldnote        # relay on 127.0.0.1:8787 + Vite on http://127.0.0.1:5173
```

Open `http://127.0.0.1:5173/?device=ana` and a second window with `?device=ben`. Each worker is its
own replica in its own IndexedDB database. Add `&schema=1` to run the old v1 schema and watch a v1
device receive only what it can read. With `WEAVE_RELAY_TOKEN` set, add `&token=<token>`.

```sh
npm run demo:fieldnote       # headless: a relay process and four workers on file storage
npx playwright test -c apps/fieldnote/test/e2e   # browser smoke test
```

## Data model

| Collection       | Field          | Merge rule                                            |
| ---------------- | -------------- | ----------------------------------------------------- |
| `inspections` v1 | `title`        | last writer wins                                      |
|                  | `location`     | last writer wins                                      |
|                  | `status`       | `open` < `in_review` < `closed`: most advanced wins   |
|                  | `assignees`    | union                                                 |
| `inspections` v2 | `site`, `zone` | last writer wins; replace v1 `location`               |
| `observations`   | `note`         | last writer wins                                      |
|                  | `severity`     | 1 to 5, the higher value wins                         |
|                  | `reading`      | last writer wins                                      |

Edits to different fields of one record are all kept.

## Schema v1 to v2

Version 2 splits `location` at the first `" / "` into `site` and `zone` (`zone` is `""` when there
is no separator). Stored ops are never rewritten: v1 ops are upgraded each time they are read, so a
record's operation history still shows the original v1 fields. A device still on v1 receives each
worker's changes only up to the first v2 change; its sync reports `partial / PEER_SCHEMA_OLDER`
until it upgrades.

## Conflict history

The conflict history view lists every concurrent edit WEAVE resolved: the field, the competing
values, the result, and whether a later edit has superseded it. It is built from
`replica.conflicts.history()` and each record's operation history.

## Retries are safe

Every button press is one intent with one `mutationId`, saved in `localStorage` before the write and
reused on retry, so a retry after a crash never records a change twice. See `src/pending.ts`.

## Files

`src/model.ts` collections and migration, `src/logic.ts` actions and views, `src/pending.ts`
stable mutation IDs, `src/app.ts` UI, `src/demo.ts` scripted demo, `test/` logic tests and the
Playwright smoke test.

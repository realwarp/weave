# GHOSTLINE

Offline-first community coordination on WEAVE: neighbours post announcements and ask for help,
and others claim, tag and fulfil requests, with or without a connection. The app uses only
WEAVE's public API; it contains no sync, hashing or encoding code.

## Run it

```sh
npm ci && npm run build
npm run dev:ghostline        # relay on 127.0.0.1:8787 + Vite on http://127.0.0.1:5173
```

Open `http://127.0.0.1:5173/?device=alice` and a second window with `?device=bob`. Each device is
its own replica in its own IndexedDB database. Work in either window, then press **Sync**. The
Vite dev server forwards `/v1/*` to the relay. With `WEAVE_RELAY_TOKEN` set, add `&token=<token>`
to the URL.

```sh
npm run demo:ghostline       # headless: a relay process and three devices on file storage
npx playwright test -c apps/ghostline/test/e2e   # browser smoke test
```

## Data model

| Collection      | Field       | Merge rule                                   |
| --------------- | ----------- | -------------------------------------------- |
| `announcements` | `title`     | last writer wins                             |
|                 | `body`      | last writer wins                             |
|                 | `status`    | `draft` -> `published`, never back (max-rank) |
|                 | `author`    | last writer wins                             |
| `requests`      | `title`     | last writer wins                             |
|                 | `details`   | last writer wins                             |
|                 | `tags`      | union: no tag is lost                        |
|                 | `claimedBy` | last writer wins: one claimant everywhere    |
|                 | `state`     | `open` -> `fulfilled` (max-rank)             |

A delete wins over a concurrent edit.

## Notices

The notices panel is built from `replica.conflicts.history()`, so a notice is shown even when the
app was closed while it happened:

- "Someone else was chosen" when your claim lost to a concurrent claim.
- "Your edit was not applied" when you edited an item that someone deleted at the same time.

## Retries are safe

Every button press is one intent with one `mutationId`. The ID is saved in `localStorage` before
the write and reused if the write is retried, so a retry after a crash or reload never creates a
second change (`replayed: true`). See `src/pending.ts`.

## Files

`src/model.ts` collections, `src/logic.ts` actions and notices, `src/pending.ts` stable mutation
IDs, `src/app.ts` UI, `src/demo.ts` scripted demo, `test/` logic tests and the Playwright smoke test.

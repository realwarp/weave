# Demo plan

A three-minute demo of WEAVE: devices that work offline, exchange changes later and end with the
same state. Everything below runs on one laptop.

## Before recording

```sh
npm ci
npm run build
npx playwright install chromium   # only for the browser smoke tests
```

Use a terminal with a large font and a browser with two windows side by side.

## Part 1: GHOSTLINE in the browser (60 s)

| Step | Do                                                                                 | Expect                                                               |
| ---- | ---------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| 1    | `npm run dev:ghostline`                                                            | `weave-relay listening on http://127.0.0.1:8787`, Vite on port 5173  |
| 2    | Open `http://127.0.0.1:5173/?device=alice` and `?device=bob` side by side          | Two empty boards, status "Ready. Your changes are saved on this device." |
| 3    | Alice: under **Ask for help**, post "Sandbags for the river path", tags `flood, urgent` | The request appears for Alice only; "1 change waiting to be shared" |
| 4    | Alice: **Sync**. Bob: **Sync**                                                     | "Up to date." on both; Bob now sees the request                      |
| 5    | Without syncing, both press **Claim** on the request                               | Each sees their own claim                                            |
| 6    | Bob: **Sync**, Alice: **Sync**, Bob: **Sync**                                       | Both show the same claimant; the other person gets a notice "Someone else was chosen" |

Say: "No server decided this. Both devices applied the same rule to the same set of changes."

## Part 2: GHOSTLINE scripted demo (45 s)

`npm run demo:ghostline`

Expected output, in order:

- `[step offline]`, `[step first-sync]`, `[step concurrent]`, `[step ordered-sync]` with every sync `complete`.
- `[step hashes]`: three lines with identical `state`, `ops` and `conflicts` hashes, then `all hashes equal: true`.
- `[step result]`: one claimant, tags `["heavy","urgent","winter"]` (both edits kept), "Park cleanup" exists = false (delete wins).
- `[step notices]`: `claim-lost` for the losing claimant, `edit-not-applied` for the person whose edit was deleted.
- `[step replay]`: `retried with the stored mutationId -> replayed: true`, then equal hashes again.
- Last line: `GHOSTLINE demo finished: all devices converged.`

## Part 3: FIELDNOTE scripted demo (60 s)

`npm run demo:fieldnote`

Expected output, in order:

- `[step v1-work]` and `[step upgrade]`: three workers on schema v1, then all reopened with v2; `"Bridge 4" at site/zone "North / A3"` shows the migration.
- `[step concurrent]` and `[step reconnect]`: cho works offline, then reconnects.
- `[step hashes]`: `all hashes equal: true` for ana, ben and cho.
- `[step result]`: both field edits kept, status `closed` (most advanced wins), severity `4` (higher wins).
- `[step conflicts]`: the conflict history view with the competing values.
- `[step history]`: the bridge's operations, the first one still `v1` with `location`.
- `[step v1-only]`: `dan sync -> partial / PEER_SCHEMA_OLDER` and the blocked origins; dan sees only the readable prefix.
- `[step v1-upgrade]`: dan upgrades and `all hashes equal: true` for four workers.

## Part 4: proof (15 s)

```sh
npm test                 # 767 tests: properties, scenarios, fuzz, relay end to end
npm run bench            # apply 10,000 ops < 5 s, sync 1,000 ops < 2 s
```

## Recording script

1. 0:00 Title card: "WEAVE: offline-first, no server decides."
2. 0:05 Part 1 in the browser, narrating steps 3 to 6.
3. 1:05 Part 2 in the terminal; pause on `all hashes equal: true` and on the notices.
4. 1:50 Part 3; pause on `partial / PEER_SCHEMA_OLDER`, then on the final equal hashes.
5. 2:50 Part 4: the test summary line and the two benchmark lines.
6. 3:00 End card: repository link, "MIT licensed, zero runtime dependencies".

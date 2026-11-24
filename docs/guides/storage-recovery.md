# Storage recovery (file adapter)

This guide covers two situations for a data directory of `fileStorage` (a replica or a relay):

1. **A stale lock.** A process was killed and its `LOCK` file stayed behind. Opening fails with
   `STORAGE_LOCKED`.
2. **Damage.** Opening fails with `STORAGE_CORRUPT`.

The steps below are executed literally by
`packages/storage/test/file/recovery-procedure.ts`, which the test suite runs after real kills on
every platform. If you change this guide, change that script too.

## When is manual recovery needed?

A writer holds `LOCK` while the directory is open. When a holder dies, WEAVE takes the lock over by
itself **only** when it can prove the holder is dead on the same machine: same host, same boot and
same PID namespace, which needs Linux with a readable `/proc`. On Windows and macOS (and Linux
without that proof) the open fails with `STORAGE_LOCKED`, the data files stay untouched, and a
person must follow the procedure below. There is deliberately no "break the lock" option.

Files you may see:

| File               | Meaning                                                                 |
| ------------------ | ----------------------------------------------------------------------- |
| `LOCK`             | The current holder: `pid`, host identity, a nonce                       |
| `LOCK.recovery`    | A recovery guard: someone is recovering this directory                  |
| `LOCK.stale-*`     | A lock moved aside by an unfinished takeover in WEAVE 0.1.0             |
| `LOCK.new-*`       | A new lock written during an automatic takeover that did not finish     |
| `MANIFEST`, `snap-*`, `journal-*` | Your data. **Never edit or delete these.**              |

## Stale lock: the six steps

Do them in order. If any check fails, stop.

### 1. Stop every process that might use the directory

Stop the app, the relay (`weave-relay`), scripts and services that point at this directory.

### 2. Confirm that no holder or recovery process is still running

Read the `pid` in `LOCK` and, if present, in `LOCK.recovery`. Check that no such process runs:

```sh
cat LOCK                        # macOS / Linux
ps -p <pid>                     # no output row: the process is gone
```

```powershell
Get-Content LOCK                # Windows
Get-Process -Id <pid> -ErrorAction SilentlyContinue   # no output: the process is gone
```

If a process with that PID is running, **stop**: either it is the holder, or the PID was reused and
you cannot tell. Find and stop it first.

### 3. Back up the entire directory

```sh
cp -a relay-data relay-data.backup-$(date +%Y%m%d%H%M)
```

```powershell
Copy-Item -Recurse relay-data "relay-data.backup-$(Get-Date -Format yyyyMMddHHmm)"
```

### 4. Inspect

List the directory and note the exact contents of `LOCK`, whether `LOCK.recovery` exists, and
which `LOCK.stale-*` and `LOCK.new-*` files exist.

### 5. Hold the guard, then remove the stale files and `LOCK`

- If `LOCK.recovery` exists, **keep it**. Otherwise create it so that it fails if someone else
  created it first (exclusive creation):

  ```sh
  set -o noclobber; echo '{"maintenance":true}' > LOCK.recovery
  ```

  ```powershell
  New-Item -ItemType File -Path LOCK.recovery -Value '{"maintenance":true}'   # fails if it exists
  ```

  If creation fails, someone else is recovering: stop.
- Read `LOCK` again. If it differs from what you noted in step 4, a process took the directory
  meanwhile: remove only the guard you created and stop.
- Delete every `LOCK.stale-*` and `LOCK.new-*` file, then delete `LOCK`. Keep `LOCK.recovery`
  while you do this.

### 6. Remove the guard last, then reopen and validate

Delete `LOCK.recovery` **as the very last step**. Removing it earlier lets a normal open race your
cleanup. Then start the app or relay normally. Opening validates the journal; if it succeeds, the
data is a whole-transaction prefix of what was written. Check that new writes work, and keep the
backup until you are satisfied.

Removing only `LOCK` while `LOCK.recovery` is present is not enough: the open still fails with
`STORAGE_LOCKED`, by design.

## Damage: `STORAGE_CORRUPT`

WEAVE fixes one case by itself: an append that was interrupted, where a valid record header
declares more bytes than the file holds. That tail is cut on open. Everything else fails closed,
and a failed open never changes `MANIFEST`, snapshots or journals.

The error's `details` tell you what was found:

| Field            | Meaning                                                       |
| ---------------- | ------------------------------------------------------------- |
| `file`           | The damaged journal file                                      |
| `offset`         | Where the damage starts                                       |
| `kind`, `reason` | What is wrong (for example a partial header or a bad checksum) |
| `validEndOffset` | The end of the last fully valid record                        |
| `truncatable`    | Whether cutting the file at `validEndOffset` is allowed        |

What to do:

1. Stop every process and back up the directory (steps 1 to 3 above).
2. If `truncatable` is `true` (a partial header of under 32 bytes, or a damaged **last** record),
   you may drop the damaged tail explicitly. The records after `validEndOffset` are lost:

   ```ts
   const storage = fileStorage({ dir, onCorruptTail: { truncateAt: validEndOffset } });
   await storage.open();
   ```

   Any other `truncateAt` value is refused.
3. If `truncatable` is `false` (damage in the middle, a bad snapshot or manifest), do not edit the
   files. Restore the directory from a backup, or start an empty directory and sync it from a peer
   or the relay: every op held elsewhere comes back, because replicas hold the full op log.

Checksums detect accidental damage such as a torn write or a bad disk. They are not a defense
against someone who can rewrite the files on purpose (see `docs/threat-model.md`).

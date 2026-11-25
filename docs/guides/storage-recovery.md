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

With the default identity, Windows and macOS never take a lock over by themselves, so on those
systems the cases below do not arise: a dead holder's lock always needs the six steps.

Where automatic takeover runs (Linux with `/proc`), its last step replaces `LOCK` with a new file.
If that step fails, the open fails and the error's `details` say what happened:

| `details.reason`       | Error            | `details.retryDisposition`  | What is on disk                                 | What to do                         |
| ---------------------- | ---------------- | --------------------------- | ----------------------------------------------- | ---------------------------------- |
| `rename-blocked`       | `STORAGE_LOCKED` | `may-retry`                 | unchanged (old `LOCK` only)                     | Open again later                   |
| `rename-not-permitted` | `STORAGE_ERROR`  | `operator-action-required`  | unchanged (old `LOCK` only)                     | Open as a user allowed to replace `LOCK`, or use the six steps |
| `cleanup-incomplete`   | `STORAGE_LOCKED` | `manual-recovery-required`  | old `LOCK`, `LOCK.recovery`, often `LOCK.new-*` | The six steps below                |
| `rename-failed`        | `STORAGE_ERROR`  | `manual-recovery-required`  | old `LOCK`, `LOCK.new-*`, `LOCK.recovery`       | Fix the cause, then the six steps  |

`details.cause` is the system error code. `rename-blocked` (Windows refusing to replace a file
that another program has open, or a denied permission, which Windows reports the same way) is seen
only in WEAVE's own tests, which inject a reliable identity. `rename-not-permitted` means the
rename is not allowed, for example in a shared directory with the sticky bit where `LOCK` belongs
to another user; trying again as the same user fails the same way. After `rename-blocked` or
`rename-not-permitted` the directory is as it was, so another program may take the lock over in
the meantime. `rename-failed` covers any other error, for example `EROFS` (the filesystem is read-only): the
old `LOCK` survives, `LOCK.new-*` and `LOCK.recovery` stay, and every later open fails with
`STORAGE_LOCKED` because the guard is present. Make the filesystem writable first, then follow the
six steps; they remove `LOCK.new-*` and `LOCK` while keeping the guard, and the guard last.

Files you may see:

| File               | Meaning                                                                 |
| ------------------ | ----------------------------------------------------------------------- |
| `LOCK`             | The current holder: `pid`, host identity, a nonce                       |
| `LOCK.recovery`    | A recovery guard: someone is recovering this directory                  |
| `LOCK.stale-*`     | A lock moved aside by an unfinished takeover in WEAVE 0.1.0             |
| `LOCK.new-*`       | A new lock from a takeover that was killed or could not clean up        |
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

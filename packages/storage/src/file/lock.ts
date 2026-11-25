/**
 * Directory locking for the file adapter (design 9.1 "Locking and stale-lock recovery").
 *
 * Principle: a lock is taken over only when its holder is PROVABLY dead. Anything that cannot be
 * proven is refused with STORAGE_LOCKED. Time never decides ownership. There is no override
 * option. A takeover runs only under the recovery guard `LOCK.recovery`, after revalidating that
 * the observed lock is still the very same lock (same nonce). A leftover guard is never removed
 * automatically; it needs the manual offline recovery procedure.
 */
import { readFile, readlink, rename, unlink, writeFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import path from 'node:path';
import { WeaveError } from '@weave/core/protocol';

/** Unique identifier for a host, combining hostname and system-level provenance. */
export interface HostId {
  /** Host name of the machine. */
  readonly hostname: string;
  /** Kernel boot ID (Linux only, null on other platforms). */
  readonly bootId: string | null;
  /** PID namespace identifier (Linux only, null on other platforms). */
  readonly pidNamespace: string | null;
}

/** Record written to the LOCK file to identify the directory holder. */
export interface LockRecord {
  /** Process ID of the holder. */
  readonly pid: number;
  /** Host identity of the holder. */
  readonly hostId: HostId;
  /** Unique nonce for this lock acquisition. */
  readonly nonce: string;
  /** Timestamp (ms) when this lock was acquired. */
  readonly startedAt: number;
}

/** Record written to the LOCK.recovery guard file during lock takeover. */
export interface GuardRecord {
  /** Unique nonce for this recovery attempt. */
  readonly recoveryNonce: string;
  /** The nonce of the lock being recovered (must match observed LOCK). */
  readonly observedLockNonce: string;
  /** Process ID of the recovery process. */
  readonly pid: number;
  /** Host identity of the recovery process. */
  readonly hostId: HostId;
}

/** Result of a liveness check for a process. */
export type Liveness = 'alive' | 'dead' | 'unknown';

/** Environment interface for lock operations (for testing and production). */
export interface LockEnvironment {
  /** Data directory path. */
  readonly dir: string;
  /** Current process ID. */
  readonly pid: number;
  /** Unique nonce for this lock attempt. */
  readonly nonce: string;
  /** Function returning current timestamp in milliseconds. */
  readonly now: () => number;
  /** Function returning this host's identity. */
  readonly hostId: () => Promise<HostId>;
  /** Function checking if a process is alive. */
  readonly isAlive: (pid: number) => Liveness;
  /** Failpoint hook for crash simulation during testing. */
  readonly failpoint: (name: string) => Promise<void>;
}

/** File name of the lock file. */
export const LOCK_FILE = 'LOCK';
/** File name of the recovery guard file. */
export const GUARD_FILE = 'LOCK.recovery';
const MAX_RESTARTS = 3;

/**
 * Reads the identity of this host from system files.
 * @returns HostId with hostname, bootId (Linux), and pidNamespace (Linux).
 * @remarks Reliable only on Linux with readable /proc filesystem.
 */
export async function defaultHostId(): Promise<HostId> {
  let bootId: string | null = null;
  let pidNamespace: string | null = null;
  if (process.platform === 'linux') {
    try {
      bootId = (await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim() || null;
    } catch {
      bootId = null;
    }
    try {
      pidNamespace = (await readlink('/proc/self/ns/pid')).trim() || null;
    } catch {
      pidNamespace = null;
    }
  }
  return { hostname: hostname(), bootId, pidNamespace };
}

/**
 * Checks if a process is alive by sending signal 0.
 * @param pid - Process ID to check.
 * @returns 'alive' if the process exists (EPERM), 'dead' if not found (ESRCH), 'unknown' otherwise.
 */
export function defaultIsAlive(pid: number): Liveness {
  try {
    process.kill(pid, 0);
    return 'alive';
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') return 'dead';
    if (code === 'EPERM') return 'alive';
    return 'unknown';
  }
}

/**
 * Returns true if the host ID contains all necessary fields for reliable identification.
 * @param id - HostId to check.
 * @returns True when hostname, bootId, and pidNamespace are all present and non-empty.
 */
export function isReliable(id: HostId): boolean {
  return id.hostname.length > 0 && !!id.bootId && !!id.pidNamespace;
}

/**
 * Compares two host IDs for equality.
 * @param a - First host ID.
 * @param b - Second host ID.
 * @returns True if hostname, bootId, and pidNamespace all match.
 */
export function sameHost(a: HostId, b: HostId): boolean {
  return a.hostname === b.hostname && a.bootId === b.bootId && a.pidNamespace === b.pidNamespace;
}

function locked(message: string, details: Record<string, unknown> = {}): WeaveError {
  return new WeaveError('STORAGE_LOCKED', message, {
    details: { ...details, guide: 'docs/guides/storage-recovery.md' },
  });
}

function isErrno(e: unknown, code: string): boolean {
  return (e as NodeJS.ErrnoException | undefined)?.code === code;
}

async function createExclusive(file: string, content: string): Promise<boolean> {
  try {
    await writeFile(file, content, { flag: 'wx' });
    return true;
  } catch (e) {
    if (isErrno(e, 'EEXIST')) return false;
    throw e;
  }
}

async function readJson<T>(file: string): Promise<T | undefined> {
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (e) {
    if (isErrno(e, 'ENOENT')) return undefined;
    throw e;
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    return {} as T; // present but unreadable: treated as unprovable
  }
}

async function exists(file: string): Promise<boolean> {
  try {
    await readFile(file);
    return true;
  } catch (e) {
    if (isErrno(e, 'ENOENT')) return false;
    return true;
  }
}

async function removeIfOwned(
  file: string,
  nonceField: 'nonce' | 'recoveryNonce',
  nonce: string,
): Promise<void> {
  const rec = await readJson<Record<string, unknown>>(file);
  if (rec !== undefined && rec[nonceField] === nonce) {
    await unlink(file).catch(() => undefined);
  }
}

function validLock(rec: Partial<LockRecord> | undefined): rec is LockRecord {
  return (
    rec !== undefined &&
    typeof rec.pid === 'number' &&
    typeof rec.nonce === 'string' &&
    typeof rec.hostId === 'object' &&
    rec.hostId !== null &&
    typeof rec.hostId.hostname === 'string'
  );
}

/**
 * Returns true when the holder is provably dead according to design 9.1 rules.
 * @param observed - The recorded lock to check.
 * @param own - This process's host identity.
 * @param env - Environment for liveness and host identity checks.
 * @returns True only when all identification fields match AND the process is confirmed dead.
 */
function provablyDead(observed: LockRecord, own: HostId, env: LockEnvironment): boolean {
  if (!isReliable(own) || !isReliable(observed.hostId)) return false;
  if (!sameHost(own, observed.hostId)) return false;
  return env.isAlive(observed.pid) === 'dead';
}

/**
 * Why the step-6 rename of `LOCK.new-*` over `LOCK` failed (design 9.1 step 6):
 * - `blocked`: Windows refused the rename (EPERM, EACCES or EBUSY on win32). Windows uses these
 *   codes both for a file that another handle has open and for a denied ACL, so the cause cannot
 *   be told apart; an open handle is the usual, transient case.
 * - `not-permitted`: POSIX `rename(2)` is not refused by open handles, so EPERM or EACCES there
 *   means the rename is not permitted (for example a sticky directory and a LOCK owned by another
 *   user, or a filesystem that does not support the rename). Permanent until an operator acts.
 * - `unexpected`: anything else (for example EROFS or EIO). The state is not understood.
 */
export type RenameFailure = 'blocked' | 'not-permitted' | 'unexpected';

/**
 * What a caller can do after a failed lock takeover (`details.retryDisposition`). This is not
 * the top-level `WeaveError.retryable`, which is reserved for transport errors (R10.2).
 */
export type RetryDisposition =
  'may-retry' | 'operator-action-required' | 'manual-recovery-required';

/**
 * Classifies a step-6 rename error.
 * @param code - The errno code of the rename error.
 * @param platform - The platform the rename ran on.
 * @returns The failure class.
 */
export function classifyRenameFailure(
  code: string | undefined,
  platform: NodeJS.Platform,
): RenameFailure {
  if (platform === 'win32') {
    return code === 'EPERM' || code === 'EACCES' || code === 'EBUSY' ? 'blocked' : 'unexpected';
  }
  return code === 'EPERM' || code === 'EACCES' ? 'not-permitted' : 'unexpected';
}

/**
 * Undoes a takeover whose final rename was refused (`blocked` or `not-permitted`), while still
 * holding the guard. The stale LOCK is never touched. The guard is released only when the pending
 * file is gone, LOCK is still the observed stale lock and the guard is still ours, so the
 * directory is exactly as it was before the takeover. Otherwise the guard stays (fail closed) and
 * the directory needs the manual recovery procedure.
 * @returns The error to throw.
 */
async function backOutRefusedRename(
  lockPath: string,
  guardPath: string,
  pending: string,
  observedNonce: string,
  guard: GuardRecord,
  kind: 'blocked' | 'not-permitted',
  cause: string,
): Promise<WeaveError> {
  const details = { cause, pendingFile: path.basename(pending) };
  try {
    await unlink(pending);
    const current = await readJson<Partial<LockRecord>>(lockPath);
    const held = await readJson<Partial<GuardRecord>>(guardPath);
    if (current?.nonce === observedNonce && held?.recoveryNonce === guard.recoveryNonce) {
      await unlink(guardPath);
      if (kind === 'blocked') {
        const retryDisposition: RetryDisposition = 'may-retry';
        return locked(
          'Replacing the stale LOCK was refused (usually another process has it open); the ' +
            'directory is unchanged; try again',
          { ...details, reason: 'rename-blocked', retryDisposition },
        );
      }
      const retryDisposition: RetryDisposition = 'operator-action-required';
      return new WeaveError(
        'STORAGE_ERROR',
        'Replacing the stale LOCK is not permitted; the directory is unchanged. Open it as a ' +
          'user allowed to replace LOCK, or follow the manual recovery guide',
        {
          details: {
            ...details,
            reason: 'rename-not-permitted',
            retryDisposition,
            guide: 'docs/guides/storage-recovery.md',
          },
        },
      );
    }
  } catch {
    // fall through: cleanup is not provably complete
  }
  const retryDisposition: RetryDisposition = 'manual-recovery-required';
  return locked(
    'The stale lock could not be replaced and cleanup did not finish; manual recovery is needed',
    { ...details, reason: 'cleanup-incomplete', retryDisposition, guardLeft: GUARD_FILE },
  );
}

/**
 * Acquires the directory lock following the guarded open procedure of design 9.1.
 * @param env - Environment with directory, identity, and failpoint hooks.
 * @throws STORAGE_LOCKED if the lock cannot be acquired or proven stale, or a takeover's
 *   replacement was blocked; STORAGE_ERROR if the replacement is not permitted or failed
 *   unexpectedly (design 9.1 step 6, `details.reason` and `details.retryDisposition`).
 */
export async function acquireLock(env: LockEnvironment): Promise<void> {
  const lockPath = path.join(env.dir, LOCK_FILE);
  const guardPath = path.join(env.dir, GUARD_FILE);
  const own = await env.hostId();
  const record: LockRecord = { pid: env.pid, hostId: own, nonce: env.nonce, startedAt: env.now() };

  for (let attempt = 0; attempt <= MAX_RESTARTS; attempt++) {
    // Step 1: a guard means a recovery is running or was interrupted.
    if (await exists(guardPath)) throw locked('A recovery guard (LOCK.recovery) is present');

    // Step 2: ordinary acquisition, re-checking the guard after creating LOCK.
    if (await createExclusive(lockPath, JSON.stringify(record))) {
      if (await exists(guardPath)) {
        await removeIfOwned(lockPath, 'nonce', env.nonce);
        throw locked('A recovery guard appeared while acquiring the lock');
      }
      return;
    }

    // Step 3: observe the existing lock.
    const observed = await readJson<Partial<LockRecord>>(lockPath);
    if (observed === undefined) continue; // it vanished: try again
    await env.failpoint('lock:after-observe');
    if (!validLock(observed))
      throw locked('The existing LOCK cannot be read, so it cannot be proven stale');
    if (!provablyDead(observed, own, env)) {
      throw locked('The data directory is in use or its lock cannot be proven stale', {
        holderPid: observed.pid,
        reliableHostId: isReliable(own) && isReliable(observed.hostId),
      });
    }

    // Step 4: take the recovery guard.
    const recoveryNonce = `${env.nonce}-r${attempt}`;
    const guard: GuardRecord = {
      recoveryNonce,
      observedLockNonce: observed.nonce,
      pid: env.pid,
      hostId: own,
    };
    if (!(await createExclusive(guardPath, JSON.stringify(guard)))) {
      throw locked('Another recovery is running');
    }
    await env.failpoint('lock:after-guard-create');

    // Step 5: revalidate the observed identity while holding the guard.
    const again = await readJson<Partial<LockRecord>>(lockPath);
    if (again === undefined || !validLock(again) || again.nonce !== observed.nonce) {
      await removeIfOwned(guardPath, 'recoveryNonce', recoveryNonce);
      // LOCK changed since the observation (its new holder may be alive or may have died too):
      // never replace it under a guard that names the old observation. Restart from step 1.
      continue;
    }
    if (!provablyDead(again, own, env)) {
      await removeIfOwned(guardPath, 'recoveryNonce', recoveryNonce);
      throw locked('The lock holder can no longer be proven dead');
    }
    await env.failpoint('lock:after-revalidate');

    // Step 6: write the new lock beside the stale one, then rename it over LOCK in one step, so
    // LOCK never goes missing. (Moving the stale LOCK aside first left a gap in which an ordinary
    // opener could create LOCK, see our guard and back out, while we found its LOCK and backed
    // out too: no owner at all.) Remove the guard LAST.
    const pending = path.join(env.dir, `LOCK.new-${recoveryNonce}`);
    if (!(await createExclusive(pending, JSON.stringify(record)))) {
      await removeIfOwned(guardPath, 'recoveryNonce', recoveryNonce);
      throw locked('A pending lock file of this recovery already exists');
    }
    await env.failpoint('lock:after-new-lock');
    try {
      await rename(pending, lockPath);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException | undefined)?.code;
      const kind = classifyRenameFailure(code, process.platform);
      if (kind === 'unexpected') {
        // State not understood: touch nothing, keep the guard (fail closed).
        throw new WeaveError(
          'STORAGE_ERROR',
          'Replacing the stale LOCK failed; LOCK.recovery is kept and every open is refused ' +
            'until the manual recovery procedure is followed',
          {
            cause: e,
            details: {
              cause: code ?? 'unknown',
              pendingFile: path.basename(pending),
              reason: 'rename-failed',
              retryDisposition: 'manual-recovery-required' satisfies RetryDisposition,
              guardLeft: GUARD_FILE,
              guide: 'docs/guides/storage-recovery.md',
            },
          },
        );
      }
      throw await backOutRefusedRename(
        lockPath,
        guardPath,
        pending,
        observed.nonce,
        guard,
        kind,
        code ?? 'unknown',
      );
    }
    await env.failpoint('lock:after-rename');
    await unlink(guardPath);
    return;
  }
  throw locked('The lock kept changing during recovery');
}

/**
 * Verifies this process still owns the directory lock before every write.
 * @param dir - Data directory path.
 * @param nonce - Nonce that was recorded when the lock was acquired.
 * @throws STORAGE_LOCK_LOST if the nonce does not match or the file is absent.
 */
export async function assertOwnership(dir: string, nonce: string): Promise<void> {
  const rec = await readJson<Partial<LockRecord>>(path.join(dir, LOCK_FILE));
  if (rec === undefined || rec.nonce !== nonce) {
    throw new WeaveError(
      'STORAGE_LOCK_LOST',
      'This process no longer owns the data directory lock',
    );
  }
}

/**
 * Releases the directory lock if this process still owns it.
 * @param dir - Data directory path.
 * @param nonce - Nonce that was recorded when the lock was acquired.
 */
export async function releaseLock(dir: string, nonce: string): Promise<void> {
  await removeIfOwned(path.join(dir, LOCK_FILE), 'nonce', nonce);
}

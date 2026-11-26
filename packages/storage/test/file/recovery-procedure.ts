/**
 * Executable version of the manual offline recovery procedure (design 9.1, R9.6(f),
 * docs/guides/storage-recovery.md). The guide's six steps, in order. The recovery guard is kept
 * (or created by exclusive creation) for the whole cleanup and removed LAST.
 */
import { cp, readFile, readdir, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Liveness } from '../../src/file/index.js';

export interface RecoveryHooks {
  /** Called between steps, so tests can race ordinary openers against the procedure. */
  readonly between?: (step: string) => Promise<void>;
  /** Liveness check of the PIDs named in the lock artifacts (step 2). */
  readonly isAlive: (pid: number) => Liveness;
  readonly backupDir: string;
  /** For the control test only: remove the guard FIRST (the unsafe order). */
  readonly unsafeReverseOrder?: boolean;
}

export type RecoveryOutcome =
  | { readonly status: 'recovered'; readonly removed: string[] }
  | { readonly status: 'stopped'; readonly reason: string };

async function readJson(file: string): Promise<Record<string, unknown> | undefined> {
  try {
    return JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

export async function runRecoveryProcedure(
  dir: string,
  hooks: RecoveryHooks,
): Promise<RecoveryOutcome> {
  const step = async (name: string): Promise<void> => hooks.between?.(name);
  const lock = path.join(dir, 'LOCK');
  const guard = path.join(dir, 'LOCK.recovery');

  // Step 1 (stop every process) is done by the caller.
  // Step 2: confirm that no holder or recovery process is still running.
  const lockRec = await readJson(lock);
  const guardRec = await readJson(guard);
  for (const rec of [lockRec, guardRec]) {
    if (
      rec !== undefined &&
      typeof rec['pid'] === 'number' &&
      hooks.isAlive(rec['pid']) !== 'dead'
    ) {
      return { status: 'stopped', reason: `process ${rec['pid']} may still be running` };
    }
  }
  await step('after-confirm');

  // Step 3: back up the entire directory.
  await cp(dir, hooks.backupDir, { recursive: true });
  await step('after-backup');

  // Step 4: inspect the artifacts.
  const names = await readdir(dir);
  const stale = names.filter((n) => n.startsWith('LOCK.stale-') || n.startsWith('LOCK.new-'));
  const inspectedLock = names.includes('LOCK') ? await readFile(lock, 'utf8') : undefined;
  const hadGuard = names.includes('LOCK.recovery');
  await step('after-inspect');

  const removed: string[] = [];
  if (hooks.unsafeReverseOrder === true) {
    // UNSAFE control order: guard first, then stale files, then LOCK.
    if (hadGuard) {
      await unlink(guard);
      removed.push('LOCK.recovery');
    }
    await step('after-guard-removed-early');
    for (const s of stale) await unlink(path.join(dir, s));
    await step('after-stale-removed');
    await unlink(lock).catch(() => undefined);
    removed.push('LOCK');
    return { status: 'recovered', removed };
  }

  // Step 5: keep the guard, or create a maintenance guard by exclusive creation.
  let createdGuard = false;
  if (!hadGuard) {
    try {
      await writeFile(guard, JSON.stringify({ maintenance: true }), { flag: 'wx' });
      createdGuard = true;
    } catch {
      return { status: 'stopped', reason: 'another party created LOCK.recovery' };
    }
  }
  await step('after-guard-held');
  // Re-read LOCK under the guard and compare with what step 4 inspected.
  let currentLock: string | undefined;
  try {
    currentLock = await readFile(lock, 'utf8');
  } catch {
    currentLock = undefined;
  }
  if (currentLock !== inspectedLock) {
    if (createdGuard) await unlink(guard);
    return { status: 'stopped', reason: 'LOCK changed since inspection' };
  }
  for (const s of stale) {
    await unlink(path.join(dir, s));
    removed.push(s);
  }
  await step('after-stale-removed');
  if (currentLock !== undefined) {
    await unlink(lock);
    removed.push('LOCK');
  }
  await step('after-lock-removed');

  // Step 6: remove the guard LAST; the caller then reopens with the normal adapter.
  await unlink(guard);
  removed.push('LOCK.recovery');
  return { status: 'recovered', removed };
}

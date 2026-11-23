/**
 * File storage adapter for Node.js (design 9.1): a checksummed append-only journal plus
 * generation snapshots, committed by an atomically replaced MANIFEST.
 *
 * Guarantees: a transaction is durable (written and fsynced) when it resolves; a failed open never
 * modifies MANIFEST, snapshots or journals; only a genuinely incomplete final append is truncated
 * automatically; any other damage fails closed with STORAGE_CORRUPT; one writer per directory.
 */
import { randomBytes } from 'node:crypto';
import {
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  stat,
  truncate,
  unlink,
  type FileHandle,
} from 'node:fs/promises';
import path from 'node:path';
import { WeaveError, systemClock, type StorageAdapter, type StorageTx } from '@weave/core/protocol';
import { SortedStore } from '../shared/sorted-store.js';
import { Mutex, OverlayTx } from '../shared/transaction.js';
import { encodeRecord, snapshotChecksum, type WriteSet } from './format.js';
import {
  acquireLock,
  assertOwnership,
  defaultHostId,
  defaultIsAlive,
  releaseLock,
  type HostId,
  type Liveness,
} from './lock.js';
import { scanJournal } from './scan.js';

/**
 * Exports essential functions and types for manual recovery and external use.
 * @remarks These are re-exported from the lock and format modules.
 */
export {
  defaultHostId,
  defaultIsAlive,
  isReliable,
  sameHost,
  LOCK_FILE,
  GUARD_FILE,
} from './lock.js';
/** Exported lock types for external use. */
export type { HostId, LockRecord, GuardRecord, Liveness } from './lock.js';
/** Exported scan types and function for external use. */
export { scanJournal, type ScanResult, type CorruptionKind } from './scan.js';
/** Exported format types and constants for external use. */
export { encodeRecord, decodeHeader, HEADER_BYTES, TRAILER_BYTES, MAGIC } from './format.js';

/** Default journal rotation size in bytes (8 MiB). */
export const DEFAULT_ROTATE_BYTES = 8 * 1024 * 1024;

/** Failpoint names for crash simulation during journal rotation. */
export const ROTATION_FAILPOINTS = [
  'after-snapshot-tmp',
  'after-snapshot-rename',
  'after-journal-create',
  'after-manifest-tmp',
  'after-manifest-rename',
  'after-cleanup',
] as const;

/** Configuration options for the file storage adapter. */
export interface FileStorageOptions {
  /** Path to the data directory. */
  readonly dir: string;
  /** Rotate the journal into a new snapshot when it grows past this size (default 8 MiB). */
  readonly rotateBytes?: number;
  /**
   * Explicit operator action (design 9.1 step 7): remove a damaged tail starting at the
   * `validEndOffset` reported by an earlier STORAGE_CORRUPT error. Accepted only for a partial
   * header or a payload-damaged LAST record; refused for anything else.
   */
  readonly onCorruptTail?: {
    /** Must equal the `validEndOffset` of the earlier STORAGE_CORRUPT error. */
    readonly truncateAt: number;
  };
  /** Test hook: called at named points; throwing simulates a crash at that point. */
  readonly failpoint?: (name: string) => void | Promise<void>;
  /** Test hook: identity of this host (default reads /proc on Linux). */
  readonly hostId?: () => Promise<HostId>;
  /** Test hook: liveness of a process (default `process.kill(pid, 0)`). */
  readonly isAlive?: (pid: number) => Liveness;
  /** Test hook: the PID written into LOCK (default `process.pid`). */
  readonly pid?: number;
  /** Receives open-time notices, for example a truncated incomplete append. */
  readonly onEvent?: (event: { type: 'open.truncated'; bytes: number }) => void;
}

/** Internal representation of the MANIFEST file contents. */
interface Manifest {
  /** Current journal generation number. */
  readonly generation: number;
  /** Name of the snapshot file for this generation. */
  readonly snapshot: string;
  /** Transaction ID covered by the snapshot. */
  readonly snapshotTxId: number;
  /** Epoch counter (increases on each open). */
  readonly epoch: number;
}

const MANIFEST = 'MANIFEST';
const snapName = (g: number): string => `snap-${g}.json`;
const journalName = (g: number): string => `journal-${g}.log`;

function corrupt(message: string, details: Record<string, unknown> = {}): WeaveError {
  return new WeaveError('STORAGE_CORRUPT', message, { details });
}

function isErrno(e: unknown, code: string): boolean {
  return (e as NodeJS.ErrnoException | undefined)?.code === code;
}

async function readOptional(file: string): Promise<Buffer | undefined> {
  try {
    return await readFile(file);
  } catch (e) {
    if (isErrno(e, 'ENOENT')) return undefined;
    throw e;
  }
}

async function fsyncDir(dir: string): Promise<void> {
  if (process.platform === 'win32') return;
  let fh: FileHandle | undefined;
  try {
    fh = await open(dir, 'r');
    await fh.sync();
  } catch {
    // Directory fsync is best effort.
  } finally {
    await fh?.close().catch(() => undefined);
  }
}

/**
 * Writes content to a temporary file, syncs, then atomically renames to the target name.
 * @param dir - Directory containing the file.
 * @param name - Target file name.
 * @param content - Content to write.
 * @param failAfterTmp - Optional failpoint hook called after writing but before rename.
 */
async function writeAtomic(
  dir: string,
  name: string,
  content: string,
  failAfterTmp?: () => Promise<void>,
): Promise<void> {
  const tmp = path.join(dir, `${name}.tmp`);
  const fh = await open(tmp, 'w');
  try {
    await fh.writeFile(content, 'utf8');
    await fh.sync();
  } finally {
    await fh.close();
  }
  await failAfterTmp?.();
  await rename(tmp, path.join(dir, name));
  await fsyncDir(dir);
}

function parseManifest(buf: Buffer): Manifest {
  let m: Partial<Manifest>;
  try {
    m = JSON.parse(buf.toString('utf8')) as Partial<Manifest>;
  } catch {
    throw corrupt('MANIFEST is not valid JSON', { file: MANIFEST });
  }
  const ok =
    Number.isSafeInteger(m.generation) &&
    (m.generation ?? 0) >= 1 &&
    m.snapshot === snapName(m.generation ?? 0) &&
    Number.isSafeInteger(m.snapshotTxId) &&
    (m.snapshotTxId ?? -1) >= 0 &&
    Number.isSafeInteger(m.epoch) &&
    (m.epoch ?? -1) >= 0;
  if (!ok) throw corrupt('MANIFEST has invalid fields', { file: MANIFEST });
  return m as Manifest;
}

function parseSnapshot(buf: Buffer, manifest: Manifest): Array<[string, string]> {
  let s: { txId?: unknown; entries?: unknown; sha256?: unknown };
  try {
    s = JSON.parse(buf.toString('utf8')) as typeof s;
  } catch {
    throw corrupt('Snapshot is not valid JSON', { file: manifest.snapshot });
  }
  if (s.txId !== manifest.snapshotTxId || !Array.isArray(s.entries)) {
    throw corrupt('Snapshot does not match MANIFEST', { file: manifest.snapshot });
  }
  const entries = s.entries as Array<[string, string]>;
  for (const e of entries) {
    if (
      !Array.isArray(e) ||
      e.length !== 2 ||
      typeof e[0] !== 'string' ||
      typeof e[1] !== 'string'
    ) {
      throw corrupt('Snapshot has an invalid entry', { file: manifest.snapshot });
    }
  }
  if (s.sha256 !== snapshotChecksum(manifest.snapshotTxId, entries)) {
    throw corrupt('Snapshot checksum mismatch', { file: manifest.snapshot });
  }
  return entries;
}

/**
 * Creates a file storage adapter with the specified options.
 * @param options - Configuration for the storage adapter.
 * @returns A StorageAdapter instance for transactional file-based storage.
 */
export function fileStorage(options: FileStorageOptions): StorageAdapter {
  const dir = path.resolve(options.dir);
  const rotateBytes = options.rotateBytes ?? DEFAULT_ROTATE_BYTES;
  const nonce = randomBytes(16).toString('hex');
  const failpoint = async (name: string): Promise<void> => {
    await options.failpoint?.(name);
  };
  const mutex = new Mutex();
  const store = new SortedStore();
  let state: 'new' | 'open' | 'closed' | 'dead' = 'new';
  let manifest: Manifest | undefined;
  let txId = 0;
  let journalSize = 0;
  let journal: FileHandle | undefined;

  /** A crash in a failpoint leaves files as they are, like a killed process (LOCK stays). */
  async function die(e: unknown): Promise<never> {
    state = 'dead';
    await journal?.close().catch(() => undefined);
    journal = undefined;
    throw e;
  }

  async function initFresh(): Promise<Manifest> {
    const fresh: Manifest = { generation: 1, snapshot: snapName(1), snapshotTxId: 0, epoch: 0 };
    await writeAtomic(
      dir,
      snapName(1),
      JSON.stringify({ txId: 0, entries: [], sha256: snapshotChecksum(0, []) }),
    );
    const fh = await open(path.join(dir, journalName(1)), 'w');
    await fh.sync();
    await fh.close();
    await writeAtomic(dir, MANIFEST, JSON.stringify(fresh));
    return fresh;
  }

  async function loadManifest(): Promise<Manifest> {
    const buf = await readOptional(path.join(dir, MANIFEST));
    if (buf !== undefined) return parseManifest(buf);
    // No MANIFEST: allowed only for a new directory (or an interrupted initialization whose
    // journal is still empty). Anything else is a damaged directory: fail closed.
    const names = await readdir(dir);
    for (const name of names) {
      if (/^journal-\d+\.log$/.test(name)) {
        const size = (await stat(path.join(dir, name))).size;
        if (size > 0) throw corrupt('MANIFEST is missing but a journal has data', { file: name });
      }
    }
    return initFresh();
  }

  async function doOpen(): Promise<void> {
    await mkdir(dir, { recursive: true });
    await acquireLock({
      dir,
      pid: options.pid ?? process.pid,
      nonce,
      now: () => systemClock.nowMs(), // display only (LOCK.startedAt)
      hostId: options.hostId ?? defaultHostId,
      isAlive: options.isAlive ?? defaultIsAlive,
      failpoint,
    });
    try {
      const m = await loadManifest();
      const snapBuf = await readOptional(path.join(dir, m.snapshot));
      if (snapBuf === undefined)
        throw corrupt('Snapshot named by MANIFEST is missing', { file: m.snapshot });
      const entries = parseSnapshot(snapBuf, m);
      const journalFile = journalName(m.generation);
      const journalBuf = await readOptional(path.join(dir, journalFile));
      if (journalBuf === undefined)
        throw corrupt('Journal of the MANIFEST generation is missing', { file: journalFile });
      const result = scanJournal(journalBuf, {
        generation: m.generation,
        snapshotTxId: m.snapshotTxId,
        manifestEpoch: m.epoch,
      });

      let truncateTo: number | undefined;
      if (result.status === 'incomplete') {
        truncateTo = result.validEnd;
      } else if (result.status === 'corrupt') {
        const details = {
          file: journalFile,
          offset: result.offset,
          kind: result.kind,
          validEndOffset: result.validEnd,
          fileSize: journalBuf.length,
          truncatable: result.truncatable,
          reason: result.reason,
        };
        const requested = options.onCorruptTail?.truncateAt;
        if (requested === undefined) throw corrupt(`Journal is damaged: ${result.reason}`, details);
        if (!result.truncatable || requested !== result.validEnd) {
          throw corrupt('The requested tail truncation is refused for this damage', {
            ...details,
            requestedTruncateAt: requested,
          });
        }
        truncateTo = requested;
      }

      // Everything verified. Writes happen only from here on (design 9.1 step 5).
      store.clear();
      for (const [k, v] of entries) store.set(k, v);
      for (const rec of result.records) store.apply(new Map(rec.writes));
      txId =
        result.records.length > 0
          ? result.records[result.records.length - 1]!.txId
          : m.snapshotTxId;

      const journalPath = path.join(dir, journalFile);
      if (truncateTo !== undefined) {
        const removed = journalBuf.length - truncateTo;
        await truncate(journalPath, truncateTo);
        const fh = await open(journalPath, 'r+');
        await fh.sync();
        await fh.close();
        options.onEvent?.({ type: 'open.truncated', bytes: removed });
      }
      for (const name of await readdir(dir)) {
        const stray =
          (/^snap-\d+\.json$/.test(name) && name !== m.snapshot) ||
          (/^journal-\d+\.log$/.test(name) && name !== journalFile) ||
          name.endsWith('.tmp');
        if (stray) await unlink(path.join(dir, name)).catch(() => undefined);
      }
      manifest = { ...m, epoch: m.epoch + 1 };
      await writeAtomic(dir, MANIFEST, JSON.stringify(manifest));
      journal = await open(journalPath, 'a');
      journalSize = truncateTo ?? journalBuf.length;
      state = 'open';
    } catch (e) {
      await releaseLock(dir, nonce).catch(() => undefined);
      throw e;
    }
  }

  async function rotate(): Promise<void> {
    const m = manifest!;
    const next = m.generation + 1;
    const entries = store.entries();
    await writeAtomic(
      dir,
      snapName(next),
      JSON.stringify({ txId, entries, sha256: snapshotChecksum(txId, entries) }),
      () => failpoint('after-snapshot-tmp'),
    );
    await failpoint('after-snapshot-rename');
    const fh = await open(path.join(dir, journalName(next)), 'w');
    await fh.sync();
    await fh.close();
    await failpoint('after-journal-create');
    const nextManifest: Manifest = {
      generation: next,
      snapshot: snapName(next),
      snapshotTxId: txId,
      epoch: m.epoch,
    };
    await writeAtomic(dir, MANIFEST, JSON.stringify(nextManifest), () =>
      failpoint('after-manifest-tmp'),
    );
    await failpoint('after-manifest-rename');
    manifest = nextManifest;
    await journal?.close();
    journal = await open(path.join(dir, journalName(next)), 'a');
    journalSize = 0;
    await unlink(path.join(dir, snapName(m.generation))).catch(() => undefined);
    await unlink(path.join(dir, journalName(m.generation))).catch(() => undefined);
    await failpoint('after-cleanup');
  }

  async function commit(writes: ReadonlyMap<string, string | null>): Promise<void> {
    if (writes.size === 0) return;
    await assertOwnership(dir, nonce);
    const writeSet: WriteSet = [...writes.entries()];
    const record = encodeRecord(
      { generation: manifest!.generation, epoch: manifest!.epoch, txId: txId + 1 },
      writeSet,
    );
    await failpoint('before-append');
    await journal!.write(record);
    await journal!.sync();
    await failpoint('after-append');
    txId += 1;
    journalSize += record.length;
    store.apply(writes);
    if (journalSize > rotateBytes) await rotate();
  }

  return {
    /** Opens the storage directory, acquires the lock, and loads state. */
    open(): Promise<void> {
      return mutex.run(async () => {
        if (state === 'open') return;
        if (state !== 'new' && state !== 'closed')
          throw new WeaveError('STORAGE_ERROR', 'This adapter instance cannot be reopened');
        await doOpen();
      });
    },

    /** Closes the storage, releasing the lock and journal handle. */
    close(): Promise<void> {
      return mutex.run(async () => {
        if (state !== 'open') {
          if (state === 'new') state = 'closed';
          return;
        }
        state = 'closed';
        await journal?.close().catch(() => undefined);
        journal = undefined;
        await releaseLock(dir, nonce);
      });
    },

    /**
     * Runs a transaction with read-only or read-write access.
     * @param mode - 'ro' for read-only, 'rw' for read-write.
     * @param fn - Transaction function that receives a StorageTx instance.
     * @returns The result of the transaction function.
     */
    transaction<T>(mode: 'ro' | 'rw', fn: (tx: StorageTx) => Promise<T>): Promise<T> {
      return mutex.run(async () => {
        if (state !== 'open')
          throw new WeaveError('STORAGE_ERROR', `The file storage adapter is ${state}`);
        const tx = new OverlayTx(store, mode);
        let result: T;
        try {
          result = await fn(tx);
        } finally {
          tx.finish();
        }
        if (mode === 'rw') {
          try {
            await commit(tx.writes);
          } catch (e) {
            if (e instanceof WeaveError && e.code === 'STORAGE_LOCK_LOST') throw e;
            // An I/O failure (or a simulated crash) leaves the in-memory state unknown: stop.
            return die(
              e instanceof WeaveError
                ? e
                : new WeaveError('STORAGE_ERROR', 'Journal write failed', { cause: e }),
            );
          }
        }
        return result;
      });
    },
  };
}

/**
 * Exposed for the manual-recovery guide and tests: file names used by the adapter.
 */
export const FILE_NAMES = {
  /** Name of the manifest file that names the current generation. */
  MANIFEST,
  /** Name of the snapshot file of a generation. */
  snapName,
  /** Name of the journal file of a generation. */
  journalName,
} as const;

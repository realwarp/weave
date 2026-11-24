import { createHash } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  fileStorage,
  type FileStorageOptions,
  type HostId,
  type Liveness,
} from '../../src/file/index.js';
import { HEADER_BYTES, TRAILER_BYTES } from '../../src/file/format.js';

export const RELIABLE_HOST: HostId = {
  hostname: 'test-host',
  bootId: 'boot-1',
  pidNamespace: 'pid:[1]',
};
export const UNPROVEN_HOST: HostId = { hostname: 'test-host', bootId: null, pidNamespace: null };

export async function tempDir(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), 'weave-file-'));
}

export async function removeDir(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true });
}

/** A process table for fake PIDs: tests decide who is alive. */
export class FakeProcesses {
  private readonly alive = new Set<number>();
  private next = 50_000;
  spawn(): number {
    const pid = this.next++;
    this.alive.add(pid);
    return pid;
  }
  kill(pid: number): void {
    this.alive.delete(pid);
  }
  probe = (pid: number): Liveness => (this.alive.has(pid) ? 'alive' : 'dead');
}

export function options(
  dir: string,
  procs: FakeProcesses,
  pid: number,
  extra: Partial<FileStorageOptions> = {},
): FileStorageOptions {
  return {
    dir,
    pid,
    isAlive: procs.probe,
    hostId: async () => RELIABLE_HOST,
    ...extra,
  };
}

/** Opens, writes `count` transactions `k/<i> = v<i>`, closes. */
export async function writeTransactions(
  opts: FileStorageOptions,
  count: number,
  from = 0,
): Promise<void> {
  const s = fileStorage(opts);
  await s.open();
  for (let i = from; i < from + count; i++) {
    await s.transaction('rw', async (tx) => {
      tx.put(`k/${String(i).padStart(4, '0')}`, `v${i}`);
    });
  }
  await s.close();
}

export async function readAll(opts: FileStorageOptions): Promise<Array<[string, string]>> {
  const s = fileStorage(opts);
  await s.open();
  try {
    return await s.transaction('ro', (tx) => tx.scan(''));
  } finally {
    await s.close();
  }
}

/** SHA-256 of every data file (MANIFEST, snapshots, journals): used to prove nothing changed. */
export async function dataFingerprint(dir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const name of (await readdir(dir)).sort()) {
    if (name === 'MANIFEST' || /^snap-\d+\.json$/.test(name) || /^journal-\d+\.log$/.test(name)) {
      out[name] = createHash('sha256')
        .update(await readFile(path.join(dir, name)))
        .digest('hex');
    }
  }
  return out;
}

/** Start offsets and lengths of every record in a journal. */
export function recordBounds(buf: Buffer): Array<{ start: number; length: number }> {
  const out: Array<{ start: number; length: number }> = [];
  let o = 0;
  while (o + HEADER_BYTES <= buf.length) {
    const len = buf.readUInt32BE(o + 20);
    const total = HEADER_BYTES + len + TRAILER_BYTES;
    out.push({ start: o, length: total });
    o += total;
  }
  return out;
}

export async function expectCode(
  p: Promise<unknown>,
  code: string,
): Promise<Record<string, unknown>> {
  try {
    await p;
  } catch (e) {
    const err = e as { code?: string; details?: Record<string, unknown> };
    if (err.code !== code)
      throw new Error(`expected ${code}, got ${String(err.code)}: ${String(e)}`);
    return err.details ?? {};
  }
  throw new Error(`expected ${code}, but it resolved`);
}

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

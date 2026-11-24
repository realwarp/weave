import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { defaultHostId, defaultIsAlive, fileStorage, isReliable } from '../../src/file/index.js';
import { expectCode, removeDir, tempDir } from './helpers.js';
import { runRecoveryProcedure } from './recovery-procedure.js';

const repoRoot = path.resolve(__dirname, '../../../..');
const writer = path.join(__dirname, 'fixtures', 'writer.ts');

/**
 * A real child process writes in a loop and is killed with SIGKILL (TerminateProcess on Windows).
 * After the kill, the result is always a whole-transaction prefix. Linux with a readable /proc takes
 * the dead holder's lock over automatically; Windows and macOS refuse with STORAGE_LOCKED until the
 * documented manual recovery has been performed.
 */
describe('forced termination of a real writer process (R10.4, R15.17)', () => {
  let dir: string;
  let backup: string;
  beforeEach(async () => {
    dir = await tempDir();
    backup = `${dir}-backup`;
  });
  afterEach(async () => {
    await removeDir(dir);
    await removeDir(backup);
  });

  it('recovers a whole-transaction prefix after SIGKILL', { timeout: 60_000 }, async () => {
    expect(existsSync(path.join(repoRoot, 'packages/core/dist/protocol.js'))).toBe(true);
    const child = spawn(process.execPath, ['--import', 'tsx', writer, dir], {
      cwd: repoRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
    await new Promise<void>((resolve, reject) => {
      let lines = 0;
      child.stdout.on('data', (d: Buffer) => {
        lines += d.toString().split('\n').filter(Boolean).length;
        if (lines >= 5) resolve();
      });
      child.on('exit', (code) =>
        reject(new Error(`writer exited early (${String(code)}): ${stderr}`)),
      );
    });
    const exited = new Promise<void>((r) => child.on('exit', () => r()));
    child.kill('SIGKILL');
    await exited;
    expect(defaultIsAlive(child.pid!)).toBe('dead');

    const reliable = isReliable(await defaultHostId());
    if (!reliable) {
      await expectCode(fileStorage({ dir }).open(), 'STORAGE_LOCKED');
      const outcome = await runRecoveryProcedure(dir, {
        isAlive: defaultIsAlive,
        backupDir: backup,
      });
      expect(outcome.status).toBe('recovered');
    }
    const s = fileStorage({ dir });
    await s.open();
    const entries = await s.transaction('ro', (tx) => tx.scan('k/'));
    const count = Number(await s.transaction('ro', (tx) => tx.get('count')));
    await s.close();
    expect(count).toBeGreaterThanOrEqual(40);
    expect(entries).toHaveLength(count);
    entries.forEach(([key, value], i) => {
      expect(key).toBe(`k/${String(i).padStart(6, '0')}`);
      expect(value).toBe(`v${i}`);
    });
  });
});

/**
 * Runs the README quick start as written (R11.2, task T1.G2): the first ```ts block under
 * "## Quick start" is extracted, written to a scratch module and imported.
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, describe, expect, it, vi } from 'vitest';

const root = fileURLToPath(new URL('../../', import.meta.url));
const scratch = fileURLToPath(new URL('./.generated/', import.meta.url));

export function extractQuickStart(markdown: string): string {
  const section = markdown.split(/^## Quick start\s*$/m)[1];
  if (section === undefined) throw new Error('README has no "## Quick start" section');
  const match = /```ts\r?\n([\s\S]*?)```/.exec(section.split(/^## /m)[0] ?? '');
  if (match === null) throw new Error('The quick start has no ```ts block');
  return match[1]!;
}

afterAll(() => rmSync(scratch, { recursive: true, force: true }));

describe('README quick start', () => {
  const code = extractQuickStart(readFileSync(`${root}README.md`, 'utf8'));

  it('is under 30 lines and supplies a mutationId on its write', () => {
    expect(code.trimEnd().split('\n').length).toBeLessThan(30);
    expect(code).toMatch(/mutationId: a\.newMutationId\(\)/);
    expect(code).toContain('memoryStorage()');
    expect(code).toContain('b.sync(a.endpoint())');
  });

  it('runs: two replicas, one write, sync returns complete, hashes are equal', async () => {
    mkdirSync(scratch, { recursive: true });
    const file = `${scratch}quickstart.ts`;
    writeFileSync(file, `${code}\nexport {};\n`);
    const lines: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      lines.push(args.map(String).join(' '));
    });
    try {
      await import(pathToFileURL(file).href);
    } finally {
      spy.mockRestore();
    }
    expect(lines).toEqual(['complete', 'Fix the gate', 'true']);
  });
});

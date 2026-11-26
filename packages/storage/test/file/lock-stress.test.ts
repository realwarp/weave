/**
 * Stress test for the takeover race (design 9.1, test (b)): many openers race for one dead
 * holder's lock, again and again, with seeded random start delays and failpoint delays. Every
 * race must end with exactly one owner and STORAGE_LOCKED for all others.
 *
 * Runs 40 races by default. For a long run set, for example:
 *   LOCK_STRESS_RUNS=3000 LOCK_STRESS_STAGGER=5 LOCK_STRESS_FP_DELAY=3 LOCK_STRESS_OUT=stats.json
 */
import { readdir, writeFile } from 'node:fs/promises';
import { expect, it } from 'vitest';
import { GUARD_FILE, fileStorage } from '../../src/file/index.js';
import { FakeProcesses, options, removeDir, tempDir } from './helpers.js';

const env = (name: string, fallback: number): number => Number(process.env[name] ?? fallback);
const RUNS = env('LOCK_STRESS_RUNS', 40);
const OPENERS = env('LOCK_STRESS_OPENERS', 8);
const STAGGER = env('LOCK_STRESS_STAGGER', 3);
const FP_DELAY = env('LOCK_STRESS_FP_DELAY', 1);
const OUT = process.env['LOCK_STRESS_OUT'];

/** Small seeded generator (mulberry32), so a failing run can be repeated. */
function seeded(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

it(
  `stress: ${OPENERS} openers race for a dead holder, ${RUNS} times`,
  { timeout: 3_600_000 },
  async () => {
    const rand = seeded(env('LOCK_STRESS_SEED', 1));
    const wait = (max: number): Promise<void> =>
      max > 0
        ? new Promise((r) => setTimeout(r, Math.floor(rand() * (max + 1))))
        : Promise.resolve();
    const stats = { runs: 0, one: 0, zero: 0, multi: 0, errors: {} as Record<string, number> };
    const bad: unknown[] = [];

    for (let run = 0; run < RUNS; run++) {
      const dir = await tempDir();
      try {
        const procs = new FakeProcesses();
        const dead = procs.spawn();
        const holder = fileStorage(options(dir, procs, dead));
        await holder.open();
        await holder.transaction('rw', async (tx) => tx.put('data/1', 'one'));
        procs.kill(dead);

        const openers = Array.from({ length: OPENERS }, () =>
          fileStorage(
            options(dir, procs, procs.spawn(), {
              failpoint: async (name) => {
                if (name.startsWith('lock:')) await wait(FP_DELAY);
              },
            }),
          ),
        );
        const results = await Promise.allSettled(
          openers.map(async (o) => {
            await wait(STAGGER);
            await o.open();
          }),
        );
        const wins = results.filter((r) => r.status === 'fulfilled').length;
        const errors = results.flatMap((r) => {
          if (r.status === 'fulfilled') return [];
          const e = r.reason as { code?: string; message?: string };
          return [`${e.code ?? 'NO_CODE'}: ${e.message ?? String(r.reason)}`];
        });
        for (const e of errors) stats.errors[e] = (stats.errors[e] ?? 0) + 1;
        stats.runs++;
        if (wins === 1) stats.one++;
        else if (wins === 0) stats.zero++;
        else stats.multi++;
        const files = (await readdir(dir)).filter((n) => n.startsWith('LOCK'));
        const wrongCode = errors.some((e) => !e.startsWith('STORAGE_LOCKED:'));
        if (wins !== 1 || wrongCode || files.includes(GUARD_FILE) || files.length !== 1)
          bad.push({ run, wins, errors, files });
        await Promise.all(openers.map((o) => o.close()));
      } finally {
        await removeDir(dir);
      }
    }

    if (OUT !== undefined) await writeFile(OUT, JSON.stringify({ ...stats, bad }, null, 2));
    expect(bad).toEqual([]);
    expect(stats.one).toBe(RUNS);
  },
);

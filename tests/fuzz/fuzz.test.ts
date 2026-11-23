/**
 * Fuzz and malformed-input tests (task T2.10, R16.1, R16.2, R4.7, R15.3). Hostile input goes to a
 * file-backed replica and to a file-backed relay over HTTP. Nothing may crash, nothing may be
 * partially written, and the data files must be byte-identical after every rejected input.
 */
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import fc from 'fast-check';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createReplica, isWeaveError, type Replica } from '@weave/core';
import { fileStorage } from '@weave/storage/file';
import { encodePushRequest } from '@weave/transport/http';
import { makeOps } from '../../packages/testing/src/transport/index.js';
import { seededRandom } from '../../packages/testing/src/faults/index.js';
import { simNotesV1 } from '../../packages/testing/src/simulator/index.js';
import { startRelay } from '../../packages/relay/src/index.js';
import { SEEDS } from '../property/helpers.js';

const dirs: string[] = [];
const temp = (name: string) => {
  const d = mkdtempSync(join(tmpdir(), `weave-fuzz-${name}-`));
  dirs.push(d);
  return d;
};

function digest(dir: string): string {
  return readdirSync(dir)
    .sort()
    .map(
      (n) =>
        `${n}:${createHash('sha256')
          .update(readFileSync(join(dir, n)))
          .digest('hex')}`,
    )
    .join('\n');
}

const X = 'xxxxxxxxxxxxxxxxxxxxxxxxxx';
const seed = SEEDS[0]!;

/** Ways to break one valid op line. Every result must be rejected. */
const mutations: Array<[string, (line: string) => string]> = [
  ['truncated', (l) => l.slice(0, Math.max(1, Math.floor(l.length / 2)))],
  ['not json', () => 'definitely not json'],
  ['array', () => '[]'],
  [
    'wrong hash',
    (l) => l.replace(/"hash":"([0-9a-f])/, (_, c: string) => `"hash":"${c === '0' ? '1' : '0'}`),
  ],
  ['changed field', (l) => l.replace('"n":', '"n":1')],
  ['non-canonical spacing', (l) => l.replace(':', ': ')],
  [
    'non-canonical key order',
    (l) => {
      const o = JSON.parse(l) as Record<string, unknown>;
      return JSON.stringify(Object.fromEntries(Object.entries(o).reverse()));
    },
  ],
  ['infinite number', (l) => l.replace(/"n":\d+/, '"n":1e400')],
  ['unsafe integer', (l) => l.replace(/"n":\d+/, '"n":9007199254740993')],
  ['lone surrogate', (l) => l.replace('"fields":{', '"fields":{"s":"\\ud800",')],
  ['missing field', (l) => l.replace(/"lamport":\d+,/, '')],
  ['extra field', (l) => l.replace('{', '{"zz":1,')],
  ['bad replica id', (l) => l.replaceAll(X, 'NOT-A-REPLICA-ID')],
  ['negative seq', (l) => l.replace(/"seq":\d+/, '"seq":-1')],
  ['huge', (l) => l.replace('"fields":{', `"fields":{"big":"${'x'.repeat(70_000)}",`)],
  ['deep', (l) => l.replace('"fields":{', `"fields":{"d":${'['.repeat(100)}${']'.repeat(100)},`)],
];

describe('fuzz: a file-backed replica', () => {
  let replica: Replica;
  let dir: string;
  let apply: (lines: readonly string[]) => Promise<unknown>;
  let valid: string[];

  beforeAll(async () => {
    dir = temp('replica');
    replica = await createReplica({
      storage: fileStorage({ dir }),
      collections: [simNotesV1],
      random: seededRandom(`fuzz:${seed}`),
    });
    const engine = replica as unknown as {
      applyIncoming(l: readonly string[], p: string): Promise<unknown>;
    };
    apply = (lines) => engine.applyIncoming(lines, X);
    valid = await makeOps(X, 6, { fields: (i) => ({ title: `t${i}`, n: i }) });
    await apply(valid.slice(0, 3));
  });
  afterAll(async () => {
    await replica.close();
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });

  for (const [name, mutate] of mutations) {
    it(`rejects a batch with a ${name} op and changes no file`, async () => {
      for (const position of [0, 1, 2]) {
        const batch = [...valid.slice(3)];
        batch.splice(position, 0, mutate(valid[3 + Math.min(position, 2)]!));
        const before = digest(dir);
        const error = await apply(batch).then(
          () => undefined,
          (e: unknown) => e,
        );
        expect(isWeaveError(error), `${name} at ${position}`).toBe(true);
        expect(digest(dir)).toBe(before);
      }
    });
  }

  it('rejects conflicting copies of one op ID anywhere in a batch', async () => {
    const other = await makeOps(X, 4, { fields: (i) => ({ title: `other${i}`, n: i }) });
    const before = digest(dir);
    // Same ID as a stored op, different content.
    await expect(apply([other[1]!])).rejects.toMatchObject({ code: 'INTEGRITY_CONFLICT' });
    // Two versions of a new ID in one batch.
    await expect(apply([valid[3]!, other[3]!])).rejects.toMatchObject({
      code: 'INTEGRITY_CONFLICT',
    });
    expect(digest(dir)).toBe(before);
    // Identical duplicates are accepted once.
    await apply([valid[3]!, valid[3]!, valid[3]!]);
    expect((await replica.status()).vector[X]).toBe(4);
  });

  it('random byte damage never crashes the engine or writes partially', async () => {
    const target = valid[4]!;
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.tuple(fc.nat({ max: target.length - 1 }), fc.integer({ min: 32, max: 126 })), {
          minLength: 1,
          maxLength: 4,
        }),
        async (edits) => {
          const chars = [...target];
          for (const [i, c] of edits) chars[i] = String.fromCharCode(c);
          const damaged = chars.join('');
          if (damaged === target) return;
          const before = digest(dir);
          const result = await apply([damaged]).then(
            () => 'ok',
            (e: unknown) => (isWeaveError(e) ? 'rejected' : `crash: ${String(e)}`),
          );
          expect(result).toBe('rejected');
          expect(digest(dir)).toBe(before);
        },
      ),
      { seed, numRuns: 150 },
    );
  });
});

describe('fuzz: a file-backed relay over HTTP', () => {
  let relay: Awaited<ReturnType<typeof startRelay>>;
  let dir: string;
  let valid: string[];
  const post = (route: string, body: string) =>
    fetch(`${relay.url}${route}`, { method: 'POST', body });

  beforeAll(async () => {
    dir = temp('relay');
    relay = await startRelay({ dir, port: 0 });
    valid = await makeOps(X, 4, { fields: (i) => ({ title: `t${i}`, n: i }) });
    const res = await post(
      '/v1/push',
      encodePushRequest({ replicaId: X, support: {}, ops: valid.slice(0, 2) }),
    );
    expect(res.status).toBe(200);
  });
  afterAll(async () => {
    await relay.close();
  });

  for (const [name, mutate] of mutations) {
    it(`rejects a push with a ${name} op with 4xx and changes no file`, async () => {
      const before = digest(dir);
      const body = encodePushRequest({
        replicaId: X,
        support: {},
        ops: [valid[2]!, mutate(valid[3]!)],
      });
      const res = await post('/v1/push', body);
      expect(res.status, name).toBeGreaterThanOrEqual(400);
      expect(res.status, name).toBeLessThan(500);
      expect(digest(dir)).toBe(before);
    });
  }

  it('random bodies on every route: 4xx, never 5xx, no file changes when rejected', async () => {
    const routes = ['/v1/pull', '/v1/push', '/v1/ack'];
    const junk = fc.oneof(
      fc.string({ maxLength: 200 }),
      fc.json().map((j) => j),
      fc.constantFrom(
        '{}',
        '{"replicaId":1}',
        '{"replicaId":"x","vector":{},"support":{},"limit":10}',
        `{"replicaId":"${X}","vector":{"${X}":-1},"support":{},"limit":10}`,
        `{"replicaId":"${X}","vector":{},"support":{},"limit":"all"}`,
        `{"replicaId":"${X}","durable":{"${X}":1.5}}`,
        `{"replicaId":"${X}","support":{}}\n${valid[2]}`,
        `{"replicaId":"${X}","support":{}}\n\n\n`,
        `{"replicaId":"../../etc","support":{}}\n`,
        `{"replicaId":"${X}","support":{"notes":0}}\n`,
        `{"replicaId":"${X}","vector":{},"support":{},"limit":5,"origins":["nope"]}`,
      ),
    );
    await fc.assert(
      fc.asyncProperty(fc.constantFrom(...routes), junk, async (route, body) => {
        const before = digest(dir);
        const res = await post(route, body);
        expect(res.status, `${route} ${body.slice(0, 80)}`).toBeLessThan(500);
        if (res.status >= 400) expect(digest(dir), `${route} ${body.slice(0, 80)}`).toBe(before);
      }),
      { seed, numRuns: 200 },
    );
    expect((await fetch(`${relay.url}/v1/health`)).status).toBe(200);
  });

  it('oversized bodies get 413 and change nothing', async () => {
    const before = digest(dir);
    const res = await post('/v1/push', 'x'.repeat(5 * 1024 * 1024));
    expect(res.status).toBe(413);
    expect(digest(dir)).toBe(before);
  });
});

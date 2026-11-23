// Performance benchmark (R20.5, design 12.4). Run after `npm run build`.
//
//   1. Apply 10,000 ops over 500 records to an empty replica on the memory adapter. Target < 5 s.
//   2. Sync a 1,000-op difference over the in-process transport. Target < 2 s.
//
// Each result is printed. The script exits non-zero only past 3x a target, so noisy CI runners do
// not cause false failures.
import { createReplica, defineCollection, f } from '@weave/core';
import { buildOp } from '@weave/core/protocol';
import { memoryStorage } from '@weave/storage/memory';
import { inProcessTransport } from '@weave/transport/in-process';

const notes = defineCollection({
  name: 'notes',
  version: 1,
  fields: {
    title: f.string({ required: true }),
    n: f.number({ resolver: 'max' }),
    tags: f.set(f.string()),
  },
});

const WRITERS = [
  'aaaaaaaaaaaaaaaaaaaaaaaaaa',
  'bbbbbbbbbbbbbbbbbbbbbbbbbb',
  'cccccccccccccccccccccccccc',
  'dddddddddddddddddddddddddd',
];

/** `count` real, hashed ops spread round-robin over `records` records and four writers. */
async function makeOps(count, records) {
  const byWriter = new Map(WRITERS.map((w) => [w, []]));
  const vector = {};
  let lamport = 0;
  for (let i = 0; i < count; i++) {
    const writer = WRITERS[i % WRITERS.length];
    const r = i % records;
    const fields =
      i < records
        ? { title: `note ${r}`, n: i, tags: [`t${i % 7}`] }
        : { n: i, tags: [`t${i % 7}`] };
    const { line, op } = await buildOp({
      replicaId: writer,
      vector,
      maxLamport: lamport,
      collection: 'notes',
      recordId: `rec${String(r).padStart(4, '0')}`,
      kind: 'set',
      schemaVersion: 1,
      fields,
    });
    lamport = op.lamport;
    vector[writer] = op.seq;
    byWriter.get(writer).push(line);
  }
  return byWriter;
}

async function applyAll(replica, byWriter, batch = 500) {
  const endpoint = replica.endpoint();
  for (const [writer, lines] of byWriter) {
    for (let i = 0; i < lines.length; i += batch) {
      await endpoint.push({
        replicaId: writer,
        support: { notes: 1 },
        ops: lines.slice(i, i + batch),
      });
    }
  }
}

const fresh = () => createReplica({ storage: memoryStorage(), collections: [notes] });
const seconds = (ms) => (ms / 1000).toFixed(2);
const results = [];

async function measure(name, targetMs, fn) {
  const start = performance.now();
  await fn();
  const ms = performance.now() - start;
  const verdict =
    ms <= targetMs ? 'ok' : ms <= 3 * targetMs ? 'slow (within 3x)' : 'FAIL (over 3x)';
  results.push({ name, ms, targetMs, fail: ms > 3 * targetMs });
  console.log(`${name}: ${seconds(ms)} s (target < ${seconds(targetMs)} s) ${verdict}`);
}

// 1. Apply 10,000 ops over 500 records.
const big = await makeOps(10_000, 500);
const target = await fresh();
await measure('apply 10,000 ops / 500 records (memory)', 5000, () => applyAll(target, big));
const status = await target.status();
const held = Object.values(status.vector).reduce((a, b) => a + b, 0);
if (held !== 10_000) throw new Error(`expected 10,000 accepted ops, got ${held}`);
await target.close();

// 2. Sync a 1,000-op difference.
const diff = await makeOps(1000, 200);
const source = await fresh();
await applyAll(source, diff);
const behind = await fresh();
let synced;
await measure('sync 1,000-op difference (in-process)', 2000, async () => {
  synced = await behind.sync(inProcessTransport(source.endpoint()));
});
if (synced.status !== 'complete') throw new Error(`sync returned ${synced.status}`);
if (JSON.stringify(await behind.hashes()) !== JSON.stringify(await source.hashes())) {
  throw new Error('hashes differ after the benchmark sync');
}
await source.close();
await behind.close();

if (results.some((r) => r.fail)) {
  console.error('bench: a result is more than 3x over its target');
  process.exit(1);
}
console.log('bench: passed');

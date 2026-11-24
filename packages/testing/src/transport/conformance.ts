/**
 * Transport and endpoint conformance suite (R9.3, design 8.1). The factory returns a FRESH, empty
 * endpoint as seen through the transport under test (for example an HTTP client talking to a relay).
 * The suite builds real, hashed ops, so it also works against endpoints that verify every line.
 *
 *   runTransportConformance('http', async () => ({ endpoint: httpTransport({ baseUrl }), close }));
 */
import { describe, expect, it } from 'vitest';
import {
  buildOp,
  newReplicaId,
  type JsonValue,
  type ReplicaId,
  type SyncEndpoint,
  type VersionVector,
} from '@weave/core/protocol';
import { seededRandom } from '../faults/random.js';

export interface TransportFixture {
  readonly endpoint: SyncEndpoint;
  readonly close?: () => Promise<void>;
}

/** Builds `count` consecutive ops of one writer, each depending on the previous one. */
export async function makeOps(
  writer: ReplicaId,
  count: number,
  options: {
    collection?: (i: number) => string;
    schemaVersion?: (i: number) => number;
    fields?: (i: number) => Record<string, JsonValue>;
    startSeq?: number;
  } = {},
): Promise<string[]> {
  const lines: string[] = [];
  let vector: VersionVector = {};
  const start = options.startSeq ?? 1;
  if (start > 1) vector = { [writer]: start - 1 };
  for (let i = 0; i < count; i++) {
    const { line, op } = await buildOp({
      replicaId: writer,
      vector,
      maxLamport: start - 1 + i,
      collection: options.collection?.(i) ?? 'notes',
      recordId: `r${i}`,
      kind: 'set',
      schemaVersion: options.schemaVersion?.(i) ?? 1,
      fields: options.fields?.(i) ?? { n: i },
    });
    lines.push(line);
    vector = { ...vector, [writer]: op.seq };
  }
  return lines;
}

export function runTransportConformance(
  name: string,
  factory: () => Promise<TransportFixture>,
): void {
  const random = seededRandom(`conformance:${name}`);
  const fresh = () => newReplicaId(random);

  async function withEndpoint(body: (e: SyncEndpoint) => Promise<void>): Promise<void> {
    const fixture = await factory();
    try {
      await body(fixture.endpoint);
    } finally {
      await fixture.close?.();
    }
  }

  describe(`transport conformance: ${name}`, () => {
    it('pulls nothing from an empty endpoint', () =>
      withEndpoint(async (e) => {
        const r = await e.pull({
          replicaId: fresh(),
          vector: {},
          support: { notes: 1 },
          limit: 100,
        });
        expect(r.ops).toEqual([]);
        expect(r.durable).toEqual({});
        expect(r.more).toBe(false);
        expect(typeof r.endpointId).toBe('string');
      }));

    it('stores pushed ops durably and returns them in seq order, byte for byte', () =>
      withEndpoint(async (e) => {
        const w = fresh();
        const ops = await makeOps(w, 5, {
          fields: (i) => ({ text: `caf\u00e9 ${i} \ud83d\ude00`, n: i }),
        });
        const pushed = await e.push({ replicaId: w, support: { notes: 1 }, ops });
        expect(pushed.durable).toEqual({ [w]: 5 });
        expect(pushed.need).toEqual({});
        const r = await e.pull({
          replicaId: fresh(),
          vector: {},
          support: { notes: 1 },
          limit: 100,
        });
        expect(r.ops).toEqual(ops);
        expect(r.more).toBe(false);
      }));

    it('respects the limit, reports more, and resumes after the puller vector', () =>
      withEndpoint(async (e) => {
        const w = fresh();
        const ops = await makeOps(w, 5);
        await e.push({ replicaId: w, support: { notes: 1 }, ops });
        const first = await e.pull({
          replicaId: fresh(),
          vector: {},
          support: { notes: 1 },
          limit: 2,
        });
        expect(first.ops).toEqual(ops.slice(0, 2));
        expect(first.more).toBe(true);
        const rest = await e.pull({
          replicaId: fresh(),
          vector: { [w]: 2 },
          support: { notes: 1 },
          limit: 10,
        });
        expect(rest.ops).toEqual(ops.slice(2));
        expect(rest.more).toBe(false);
      }));

    it('limit 0 is a pure vector exchange', () =>
      withEndpoint(async (e) => {
        const w = fresh();
        await e.push({ replicaId: w, support: { notes: 1 }, ops: await makeOps(w, 3) });
        const r = await e.pull({ replicaId: fresh(), vector: {}, support: { notes: 1 }, limit: 0 });
        expect(r.ops).toEqual([]);
        expect(r.durable).toEqual({ [w]: 3 });
        expect(r.more).toBe(true);
        const caughtUp = await e.pull({
          replicaId: fresh(),
          vector: { [w]: 3 },
          support: { notes: 1 },
          limit: 0,
        });
        expect(caughtUp.more).toBe(false);
      }));

    it('ignores duplicate pushes', () =>
      withEndpoint(async (e) => {
        const w = fresh();
        const ops = await makeOps(w, 3);
        await e.push({ replicaId: w, support: { notes: 1 }, ops });
        const again = await e.push({ replicaId: w, support: { notes: 1 }, ops: [...ops, ops[0]!] });
        expect(again.durable).toEqual({ [w]: 3 });
        const r = await e.pull({
          replicaId: fresh(),
          vector: {},
          support: { notes: 1 },
          limit: 100,
        });
        expect(r.ops).toHaveLength(3);
      }));

    it('reports a gap through need and stores only the contiguous prefix', () =>
      withEndpoint(async (e) => {
        const w = fresh();
        const ops = await makeOps(w, 5);
        const res = await e.push({
          replicaId: w,
          support: { notes: 1 },
          ops: [ops[0]!, ops[1]!, ops[3]!, ops[4]!],
        });
        expect(res.durable).toEqual({ [w]: 2 });
        expect(res.need).toEqual({ [w]: 3 });
        const filled = await e.push({ replicaId: w, support: { notes: 1 }, ops: ops.slice(2) });
        expect(filled.durable).toEqual({ [w]: 5 });
      }));

    it('withholds unreadable ops per origin and never skips ahead (R4.10)', () =>
      withEndpoint(async (e) => {
        const x = fresh();
        const y = fresh();
        const xs = await makeOps(x, 3, {
          collection: (i) => (i === 1 ? 'other' : 'notes'),
          schemaVersion: (i) => (i === 1 ? 2 : 1),
        });
        const ys = await makeOps(y, 2);
        await e.push({ replicaId: x, support: { notes: 1, other: 2 }, ops: xs });
        await e.push({ replicaId: y, support: { notes: 1 }, ops: ys });
        const r = await e.pull({
          replicaId: fresh(),
          vector: {},
          support: { notes: 1, other: 1 },
          limit: 100,
        });
        expect(new Set(r.ops)).toEqual(new Set([xs[0], ...ys]));
        expect(r.ops).toHaveLength(3);
        expect(r.ops).not.toContain(xs[2]);
        expect(r.blocked).toEqual([
          { origin: x, seq: 2, collection: 'other', requiredVersion: 2, direction: 'pull' },
        ]);
      }));

    it('restricts a pull to the requested origins', () =>
      withEndpoint(async (e) => {
        const x = fresh();
        const y = fresh();
        await e.push({ replicaId: x, support: { notes: 1 }, ops: await makeOps(x, 2) });
        await e.push({ replicaId: y, support: { notes: 1 }, ops: await makeOps(y, 2) });
        const r = await e.pull({
          replicaId: fresh(),
          vector: {},
          support: { notes: 1 },
          limit: 100,
          origins: [y],
        });
        expect(r.ops).toHaveLength(2);
        expect(r.ops.every((l) => l.includes(`"replicaId":"${y}"`))).toBe(true);
      }));

    it('rejects a tampered op line and stores nothing from that push', () =>
      withEndpoint(async (e) => {
        const w = fresh();
        const ops = await makeOps(w, 2);
        const tampered = ops[1]!.replace('"n":1', '"n":9');
        await expect(
          e.push({ replicaId: w, support: { notes: 1 }, ops: [ops[0]!, tampered] }),
        ).rejects.toMatchObject({
          code: 'INTEGRITY_CONFLICT',
        });
        const r = await e.pull({ replicaId: fresh(), vector: {}, support: { notes: 1 }, limit: 0 });
        expect(r.durable).toEqual({});
      }));

    it('accepts acknowledgements', () =>
      withEndpoint(async (e) => {
        const w = fresh();
        await e.push({ replicaId: w, support: { notes: 1 }, ops: await makeOps(w, 1) });
        await expect(e.ack({ replicaId: fresh(), durable: { [w]: 1 } })).resolves.toBeUndefined();
      }));
  });
}

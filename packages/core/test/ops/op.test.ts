import { describe, expect, it } from 'vitest';
import { encodeCanonical } from '../../src/canonical/encode.js';
import { opHash } from '../../src/canonical/hash.js';
import { WeaveError } from '../../src/contracts/errors.js';
import type { Op } from '../../src/contracts/op.js';
import { buildOp, readEnvelope, serializeOp, verifyOpLine } from '../../src/ops/op.js';
import { compareD4, happensBefore, isConcurrent } from '../../src/ops/order.js';
import {
  compareVectors,
  mergeVectors,
  minVectors,
  vectorCovers,
  vectorDifference,
  vectorsEqual,
} from '../../src/ops/vector.js';

const A = 'aaaaaaaaaaaaaaaaaaaaaaaaaa';
const B = 'bbbbbbbbbbbbbbbbbbbbbbbbbb';

async function make(overrides: Partial<Parameters<typeof buildOp>[0]> = {}) {
  return buildOp({
    replicaId: A,
    vector: {},
    maxLamport: 0,
    collection: 'notes',
    recordId: 'r1',
    kind: 'set',
    schemaVersion: 1,
    fields: { title: 'Hello' },
    ...overrides,
  });
}

async function expectCode(p: Promise<unknown>, code: string): Promise<void> {
  await expect(p).rejects.toBeInstanceOf(WeaveError);
  await p.catch((e: WeaveError) => expect(e.code).toBe(code));
}

/** Re-encode a modified op without fixing its hash. */
function tamper(op: Op, patch: Record<string, unknown>): string {
  return encodeCanonical({ ...op, ...patch });
}

describe('buildOp (D1, D2)', () => {
  it('derives seq, lamport and context from the accepted state', async () => {
    const { op } = await make({ vector: { [A]: 4, [B]: 2 }, maxLamport: 9 });
    expect(op.seq).toBe(5);
    expect(op.lamport).toBe(10);
    expect(op.context).toEqual({ [A]: 4, [B]: 2 });
    expect(op.hash).toBe(await opHash(op));
  });

  it('a delete has empty fields', async () => {
    const { op } = await make({ kind: 'delete' });
    expect(op.fields).toEqual({});
  });

  it('wall clock does not influence the hash (R2.4 clock independence)', async () => {
    const early = await make({ wallTime: 0 });
    const late = await make({ wallTime: 4_102_444_800_000 });
    const none = await make();
    expect(early.op.hash).toBe(late.op.hash);
    expect(none.op.hash).toBe(late.op.hash);
    expect(early.line).not.toBe(late.line);
  });

  it('rejects unsupported field values and bad names', async () => {
    await expectCode(make({ fields: { when: new Date() as never } }), 'UNSUPPORTED_VALUE');
    await expectCode(make({ collection: '1bad' }), 'VALIDATION_FAILED');
    await expectCode(make({ recordId: 'a/b' }), 'VALIDATION_FAILED');
    await expectCode(make({ fields: { '': 1 } }), 'VALIDATION_FAILED');
  });

  it('enforces the size limit', async () => {
    await expectCode(make({ fields: { big: 'x'.repeat(70_000) } }), 'VALIDATION_FAILED');
    await expect(
      make({ fields: { big: 'x'.repeat(70_000) }, maxOpBytes: 200_000 }),
    ).resolves.toBeTruthy();
  });
});

describe('verifyOpLine (R16.1, R16.2)', () => {
  it('accepts its own lines and round-trips', async () => {
    const { op, line } = await make({ wallTime: 123 });
    const parsed = await verifyOpLine(line);
    expect(parsed).toEqual(op);
    expect(serializeOp(parsed)).toBe(line);
    expect(readEnvelope(line)).toEqual({
      replicaId: A,
      seq: 1,
      collection: 'notes',
      schemaVersion: 1,
      hash: op.hash,
    });
  });

  it('rejects a hash that does not match the content (INTEGRITY_CONFLICT)', async () => {
    const { op } = await make();
    await expectCode(verifyOpLine(tamper(op, { fields: { title: 'Evil' } })), 'INTEGRITY_CONFLICT');
  });

  it('changing wallTime does not break the hash', async () => {
    const { op } = await make({ wallTime: 1 });
    await expect(verifyOpLine(tamper(op, { wallTime: 999 }))).resolves.toBeTruthy();
  });

  it('rejects non-canonical lines', async () => {
    const { line } = await make();
    await expectCode(verifyOpLine(line.replace('{', '{ ')), 'VALIDATION_FAILED');
    const reordered = JSON.stringify(JSON.parse(line), Object.keys(JSON.parse(line)).reverse());
    await expectCode(verifyOpLine(reordered), 'VALIDATION_FAILED');
  });

  it('rejects broken structure', async () => {
    const { op } = await make();
    const cases: Array<[string, string]> = [
      ['not json', 'VALIDATION_FAILED'],
      ['[1]', 'VALIDATION_FAILED'],
      [tamper(op, { extra: 1 }), 'VALIDATION_FAILED'],
      [
        encodeCanonical(Object.fromEntries(Object.entries(op).filter(([k]) => k !== 'hash'))),
        'VALIDATION_FAILED',
      ],
      [tamper(op, { seq: 0 }), 'VALIDATION_FAILED'],
      [tamper(op, { seq: 2 }), 'VALIDATION_FAILED'],
      [tamper(op, { lamport: 1.5 }), 'VALIDATION_FAILED'],
      [tamper(op, { replicaId: 'UPPER' }), 'VALIDATION_FAILED'],
      [tamper(op, { context: { bad: 1 } }), 'VALIDATION_FAILED'],
      [tamper(op, { kind: 'weird' }), 'VALIDATION_FAILED'],
      [tamper(op, { kind: 'delete' }), 'VALIDATION_FAILED'],
      [tamper(op, { hash: 'zz' }), 'VALIDATION_FAILED'],
      [tamper(op, { wallTime: 'x' }), 'VALIDATION_FAILED'],
      [tamper(op, { fields: { n: 2 ** 60 } }), 'UNSUPPORTED_VALUE'],
      [tamper(op, { kind: 'restore' }), 'NOT_SUPPORTED'],
    ];
    for (const [line, code] of cases) await expectCode(verifyOpLine(line), code);
  });

  it('rejects oversized lines before parsing', async () => {
    const { op } = await make({ fields: { big: 'x'.repeat(1000) }, maxOpBytes: 10_000 });
    await expectCode(verifyOpLine(serializeOp(op), { maxOpBytes: 500 }), 'VALIDATION_FAILED');
  });
});

describe('causal and total order (D3, D4)', () => {
  it('happens-before reads the context directly', async () => {
    const a1 = (await make()).op;
    const b1 = (await make({ replicaId: B, vector: { [A]: 1 }, maxLamport: 1 })).op;
    const a2 = (await make({ vector: { [A]: 1 }, maxLamport: 1 })).op;
    expect(happensBefore(a1, b1)).toBe(true);
    expect(happensBefore(b1, a1)).toBe(false);
    expect(isConcurrent(b1, a2)).toBe(true);
    expect(isConcurrent(a1, a1)).toBe(false);
    expect(a1.lamport).toBeLessThan(b1.lamport);
  });

  it('D4 orders by lamport, then replicaId by UTF-8 bytes, then seq', () => {
    expect(
      compareD4({ lamport: 1, replicaId: B, seq: 9 }, { lamport: 2, replicaId: A, seq: 1 }),
    ).toBeLessThan(0);
    expect(
      compareD4({ lamport: 2, replicaId: A, seq: 9 }, { lamport: 2, replicaId: B, seq: 1 }),
    ).toBeLessThan(0);
    expect(
      compareD4({ lamport: 2, replicaId: A, seq: 1 }, { lamport: 2, replicaId: A, seq: 2 }),
    ).toBeLessThan(0);
    expect(
      compareD4({ lamport: 2, replicaId: A, seq: 1 }, { lamport: 2, replicaId: A, seq: 1 }),
    ).toBe(0);
  });
});

describe('version vectors', () => {
  it('merges, compares and measures', () => {
    expect(mergeVectors({ [A]: 2 }, { [A]: 1, [B]: 3 })).toEqual({ [A]: 2, [B]: 3 });
    expect(minVectors({ [A]: 2 }, { [A]: 1, [B]: 3 })).toEqual({ [A]: 1 });
    expect(vectorsEqual({ [A]: 1, [B]: 0 }, { [A]: 1 })).toBe(true);
    expect(vectorCovers({ [A]: 3 }, { replicaId: A, seq: 3 })).toBe(true);
    expect(vectorCovers({ [A]: 3 }, { replicaId: A, seq: 4 })).toBe(false);
    expect(compareVectors({ [A]: 1 }, { [A]: 2 })).toBe('before');
    expect(compareVectors({ [A]: 2 }, { [B]: 1 })).toBe('concurrent');
    expect(compareVectors({}, {})).toBe('equal');
    expect(vectorDifference({ [A]: 5, [B]: 1 }, { [A]: 2 })).toBe(4);
  });
});

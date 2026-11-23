import { readFileSync } from 'node:fs';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  assertSupported,
  compareUtf8,
  conflictViewHash,
  encodeCanonical,
  mutationPayloadHash,
  opHash,
  opSetHash,
  sha256Hex,
  stateHash,
  toCanonical,
} from '../../src/canonical/index.js';
import { WeaveError } from '../../src/contracts/errors.js';

interface VectorFile {
  vectors: Array<{
    name: string;
    inputJson: string;
    canonical: string;
    sha256: string;
    supported: boolean;
  }>;
  setUnion: Array<{ name: string; inputJson: string; expectedJson: string }>;
  rejectedJson: Array<{ name: string; inputJson: string }>;
  rejectedJs: string[];
}

const file = JSON.parse(
  readFileSync(new URL('./vectors.json', import.meta.url), 'utf8'),
) as VectorFile;

function expectCode(fn: () => unknown, code: string): void {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(WeaveError);
    expect((e as WeaveError).code).toBe(code);
    return;
  }
  throw new Error(`expected ${code}`);
}

class Custom {
  a = 1;
}

function rejectedJsValue(name: string): unknown {
  const cyclic: Record<string, unknown> = {};
  cyclic['self'] = cyclic;
  switch (name) {
    case 'undefined':
      return undefined;
    case 'NaN':
      return NaN;
    case 'Infinity':
      return Infinity;
    case '-Infinity':
      return -Infinity;
    case 'bigint':
      return 10n;
    case 'symbol':
      return Symbol('s');
    case 'function':
      return () => 1;
    case 'Date':
      return new Date(0);
    case 'Map':
      return new Map();
    case 'Set':
      return new Set();
    case 'Uint8Array':
      return new Uint8Array(2);
    case 'class-instance':
      return new Custom();
    case 'cycle':
      return cyclic;
    case 'lone-surrogate':
      return 'a\ud800b';
    case 'undefined-in-array':
      return [1, undefined];
    case 'undefined-property':
      return { a: undefined };
    default:
      throw new Error(`unknown rejectedJs case ${name}`);
  }
}

describe('canonical vectors (D7, R15.10)', () => {
  for (const v of file.vectors) {
    it(`encodes ${v.name}`, async () => {
      const value: unknown = JSON.parse(v.inputJson);
      const text = encodeCanonical(value);
      expect(text).toBe(v.canonical);
      expect(await sha256Hex(text)).toBe(v.sha256);
      if (v.supported) {
        expect(toCanonical(value)).toBe(v.canonical);
      } else {
        expectCode(() => assertSupported(value), 'UNSUPPORTED_VALUE');
      }
    });
  }

  for (const r of file.rejectedJson) {
    it(`rejects ${r.name}`, () => {
      expectCode(() => assertSupported(JSON.parse(r.inputJson)), 'UNSUPPORTED_VALUE');
    });
  }

  for (const name of file.rejectedJs) {
    it(`rejects JS value ${name}`, () => {
      expectCode(() => toCanonical(rejectedJsValue(name)), 'UNSUPPORTED_VALUE');
    });
  }

  it('reports the JSON path of an unsupported value', () => {
    try {
      assertSupported({ a: [1, { b: NaN }] });
      throw new Error('no throw');
    } catch (e) {
      expect((e as WeaveError).details['path']).toBe('$.a[1].b');
    }
  });

  it('enforces the depth limit', () => {
    let deep: unknown = 1;
    for (let i = 0; i < 40; i++) deep = [deep];
    expectCode(() => assertSupported(deep), 'UNSUPPORTED_VALUE');
    expect(() => assertSupported(deep, { maxDepth: 64 })).not.toThrow();
  });

  it('writes -0 as 0 and allows shared (non-cyclic) references', () => {
    const shared = { x: 1 };
    expect(toCanonical({ a: -0, b: shared, c: shared })).toBe('{"a":0,"b":{"x":1},"c":{"x":1}}');
  });
});

describe('orderings', () => {
  it('compareUtf8 is UTF-8 byte order, unlike the default UTF-16 sort', () => {
    const a = '\ue000';
    const b = '\ud800\udc00';
    expect(compareUtf8(a, b)).toBeLessThan(0);
    expect([b, a].sort()).toEqual([b, a]);
    expect(compareUtf8('a', 'ab')).toBeLessThan(0);
    expect(compareUtf8('b', 'a')).toBeGreaterThan(0);
    expect(compareUtf8('x', 'x')).toBe(0);
  });

  it('compareUtf8 matches Buffer.compare on random strings', () => {
    fc.assert(
      fc.property(fc.string({ unit: 'grapheme' }), fc.string({ unit: 'grapheme' }), (a, b) => {
        const expected = Math.sign(Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8')));
        expect(Math.sign(compareUtf8(a, b))).toBe(expected);
      }),
    );
  });
});

const arbKey = fc.string({ unit: 'grapheme', maxLength: 6 });
const arbValue = fc.letrec((tie) => ({
  value: fc.oneof(
    { depthSize: 'small' },
    fc.constant(null),
    fc.boolean(),
    fc.integer(),
    fc.double({ noNaN: true, noDefaultInfinity: true }).filter((n) => !Number.isInteger(n)),
    fc.string({ unit: 'grapheme' }),
    fc.array(tie('value'), { maxLength: 4 }),
    fc.dictionary(arbKey, tie('value'), { maxKeys: 4 }),
  ),
})).value;

describe('canonical encoding properties', () => {
  it('key insertion order never changes the bytes', () => {
    fc.assert(
      fc.property(fc.dictionary(arbKey, arbValue, { maxKeys: 8 }), (obj) => {
        const reversed: Record<string, unknown> = {};
        for (const k of Object.keys(obj).reverse()) reversed[k] = obj[k];
        expect(toCanonical(reversed)).toBe(toCanonical(obj));
      }),
    );
  });

  it('canonical text parses back to an equal value and re-encodes identically', () => {
    fc.assert(
      fc.property(arbValue, (v) => {
        const text = toCanonical(v);
        expect(encodeCanonical(JSON.parse(text))).toBe(text);
      }),
    );
  });

  it('unsafe integers are always rejected', () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 2n ** 53n, max: 2n ** 60n }).map((b) => Number(b)),
        (n) => {
          expectCode(() => assertSupported({ n }), 'UNSUPPORTED_VALUE');
        },
      ),
    );
  });
});

describe('hash inputs', () => {
  const payload = {
    replicaId: 'aaaaaaaaaaaaaaaaaaaaaaaaaa',
    seq: 1,
    lamport: 1,
    context: {},
    collection: 'notes',
    recordId: 'r1',
    kind: 'set' as const,
    schemaVersion: 1,
    fields: { title: 'Hello' },
  };

  it('op hash equals the op-payload vector and ignores hash and wallTime', async () => {
    const vector = file.vectors.find((v) => v.name === 'op-payload')!;
    expect(await opHash(payload)).toBe(vector.sha256);
    const withExtras = { ...payload, hash: 'x', wallTime: 5 } as unknown as typeof payload;
    expect(await opHash(withExtras)).toBe(vector.sha256);
  });

  it('every payload field changes the op hash', async () => {
    const base = await opHash(payload);
    const variants = [
      { ...payload, replicaId: 'baaaaaaaaaaaaaaaaaaaaaaaaa' },
      { ...payload, seq: 2 },
      { ...payload, lamport: 2 },
      { ...payload, context: { baaaaaaaaaaaaaaaaaaaaaaaaa: 1 } },
      { ...payload, collection: 'other' },
      { ...payload, recordId: 'r2' },
      { ...payload, kind: 'delete' as const, fields: {} },
      { ...payload, schemaVersion: 2 },
      { ...payload, fields: { title: 'Hi' } },
    ];
    for (const v of variants) expect(await opHash(v)).not.toBe(base);
  });

  it('state, op-set and conflict-view hashes do not depend on input order', async () => {
    const e1 = ['a', 'r1', false, { x: 1 }] as const;
    const e2 = ['a', 'r2', true, { y: 2 }] as const;
    const e3 = ['b', 'r1', false, {}] as const;
    expect(await stateHash([e1, e2, e3])).toBe(await stateHash([e3, e1, e2]));
    expect(await stateHash([e2])).toBe(await stateHash([['a', 'r2', true, {}]]));
    expect(await opSetHash(['b', 'a', 'c'])).toBe(await opSetHash(['c', 'b', 'a']));
    expect(
      await conflictViewHash([
        ['y', 1],
        ['x', undefined],
      ]),
    ).toBe(
      await conflictViewHash([
        ['x', null],
        ['y', 1],
      ]),
    );
  });

  it('mutation payload hash covers collection, kind, recordId and fields', async () => {
    const base = { collection: 'c', kind: 'set' as const, recordId: null, fields: { a: 1 } };
    const h = await mutationPayloadHash(base);
    expect(await mutationPayloadHash({ ...base, recordId: 'r' })).not.toBe(h);
    expect(await mutationPayloadHash({ ...base, fields: { a: 2 } })).not.toBe(h);
    expect(await mutationPayloadHash({ ...base })).toBe(h);
  });
});

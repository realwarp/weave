import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { isSupported, selectFromLoaded, type OpEnvelope } from '../../src/sync/select.js';

const X = 'xxxxxxxxxxxxxxxxxxxxxxxxxx';
const Y = 'yyyyyyyyyyyyyyyyyyyyyyyyyy';

const env = (seq: number, collection: string, schemaVersion = 1): OpEnvelope => ({
  seq,
  collection,
  schemaVersion,
  line: `${collection}:${seq}:${schemaVersion}`,
});

describe('isSupported', () => {
  it('accepts supported collections at or below the version, and everything for *', () => {
    expect(isSupported(env(1, 'a', 1), { a: 1 })).toBe(true);
    expect(isSupported(env(1, 'a', 2), { a: 1 })).toBe(false);
    expect(isSupported(env(1, 'b', 1), { a: 1 })).toBe(false);
    expect(isSupported(env(1, 'b', 9), '*')).toBe(true);
  });
});

describe('selectReadablePrefix (R4.10)', () => {
  it('R15.11 shape: op 3 of a readable collection is withheld behind unreadable op 2', async () => {
    const out = await selectFromLoaded(
      { [X]: [env(1, 'A'), env(2, 'B', 2), env(3, 'A')] },
      { peerVector: {}, support: { A: 1, B: 1 }, limit: 100, direction: 'pull' },
    );
    expect(out.lines).toEqual(['A:1:1']);
    expect(out.blocked).toEqual([
      { origin: X, seq: 2, collection: 'B', requiredVersion: 2, direction: 'pull' },
    ]);
    expect(out.more).toBe(false);
  });

  it('other origins are unaffected by a blocked origin', async () => {
    const out = await selectFromLoaded(
      { [X]: [env(1, 'B', 3), env(2, 'A')], [Y]: [env(1, 'A'), env(2, 'A')] },
      { peerVector: {}, support: { A: 1 }, limit: 100, direction: 'push' },
    );
    expect(out.lines).toEqual(['A:1:1', 'A:2:1']);
    expect(out.blocked.map((b) => [b.origin, b.seq, b.direction])).toEqual([[X, 1, 'push']]);
  });

  it('starts after the peer vector and respects the limit, reporting more', async () => {
    const ops = { [X]: [env(1, 'A'), env(2, 'A'), env(3, 'A'), env(4, 'A')] };
    const out = await selectFromLoaded(ops, {
      peerVector: { [X]: 1 },
      support: '*',
      limit: 2,
      direction: 'pull',
    });
    expect(out.lines).toEqual(['A:2:1', 'A:3:1']);
    expect(out.more).toBe(true);
    const rest = await selectFromLoaded(ops, {
      peerVector: { [X]: 3 },
      support: '*',
      limit: 2,
      direction: 'pull',
    });
    expect(rest.lines).toEqual(['A:4:1']);
    expect(rest.more).toBe(false);
  });

  it('limit 0 emits nothing but reports more and blocked origins', async () => {
    const out = await selectFromLoaded(
      { [X]: [env(1, 'A')], [Y]: [env(1, 'Z')] },
      { peerVector: {}, support: { A: 1 }, limit: 0, direction: 'pull' },
    );
    expect(out.lines).toEqual([]);
    expect(out.more).toBe(true);
    expect(out.blocked.map((b) => b.origin)).toEqual([Y]);
  });

  it('the origins filter restricts selection', async () => {
    const out = await selectFromLoaded(
      { [X]: [env(1, 'A')], [Y]: [env(1, 'A')] },
      { peerVector: {}, support: '*', limit: 10, direction: 'pull', origins: [Y] },
    );
    expect(out.perOrigin.map((p) => p.origin)).toEqual([Y]);
  });

  it('property: the output is a prefix per origin and never skips an unreadable op', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(
          fc.record({
            collection: fc.constantFrom('A', 'B'),
            version: fc.integer({ min: 1, max: 2 }),
          }),
          {
            maxLength: 12,
          },
        ),
        fc.integer({ min: 0, max: 15 }),
        async (spec, limit) => {
          const ops = spec.map((s, i) => env(i + 1, s.collection, s.version));
          const support = { A: 1, B: 2 };
          const out = await selectFromLoaded(
            { [X]: ops },
            { peerVector: {}, support, limit, direction: 'pull' },
          );
          const firstBad = ops.findIndex((o) => !isSupported(o, support));
          const readable = firstBad < 0 ? ops.length : firstBad;
          expect(out.lines).toEqual(ops.slice(0, Math.min(readable, limit)).map((o) => o.line));
          expect(out.blocked.length).toBe(firstBad >= 0 && limit >= firstBad ? 1 : 0);
        },
      ),
    );
  });
});

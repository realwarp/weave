/**
 * Counter totals near `Number.MAX_SAFE_INTEGER` (PR #2 review, F1). Every per-replica total in a
 * counter state is a safe integer (`isCounterState`), so a total is exact only if the sum is
 * computed without intermediate rounding; the safe-integer check must apply to the exact result.
 */
import { describe, expect, it } from 'vitest';
import { counterTotal, type CounterState } from '../../src/resolvers/counter.js';

const MAX = Number.MAX_SAFE_INTEGER;
// Replica IDs sort in this order (UTF-8), so the summation order is fixed: a, b, c.
const A = 'aaaaaaaaaaaaaaaaaaaaaa';
const B = 'bbbbbbbbbbbbbbbbbbbbbb';
const C = 'cccccccccccccccccccccc';

describe('counterTotal precision (F1)', () => {
  it('MAX_SAFE_INTEGER + 2 - 2 is exactly MAX_SAFE_INTEGER', () => {
    const state: CounterState = { [A]: [MAX, 0], [B]: [2, 0], [C]: [0, 2] };
    expect(counterTotal(state)).toBe(MAX);
  });

  it('the reported case [MAX, 0], [MAX - 1, 0], [0, MAX - 1] totals MAX', () => {
    const state: CounterState = { [A]: [MAX, 0], [B]: [MAX - 1, 0], [C]: [0, MAX - 1] };
    expect(counterTotal(state)).toBe(MAX);
  });

  it('a negative boundary: -MAX + (-2) + 2 is exactly -MAX', () => {
    const state: CounterState = { [A]: [0, MAX], [B]: [0, 2], [C]: [2, 0] };
    expect(counterTotal(state)).toBe(-MAX);
  });

  it('a true total above MAX_SAFE_INTEGER is still refused', () => {
    expect(() => counterTotal({ [A]: [MAX, 0], [B]: [1, 0] })).toThrow(/not a safe integer/);
    expect(() => counterTotal({ [A]: [0, MAX], [B]: [0, 1] })).toThrow(/not a safe integer/);
  });

  it('ordinary totals are unchanged', () => {
    expect(counterTotal({})).toBe(0);
    expect(counterTotal({ [A]: [5, 2], [B]: [1, 7] })).toBe(-3);
  });
});

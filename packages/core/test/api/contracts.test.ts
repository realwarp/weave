import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  ERROR_CODES,
  WeaveError,
  keys,
  padSeq,
  type Collection,
  type CollectionDefinition,
  type FieldSpec,
  type InferRecord,
  type SyncResult,
} from '../../src/contracts/index.js';

// A hand-built definition (the real builders arrive with T1.A4); it only drives type inference.
type Str = FieldSpec<string> & { required: true };
type OptTags = FieldSpec<string[]> & { required: false };
type Def = CollectionDefinition<{ title: Str; tags: OptTags }>;

describe('contract freeze: types', () => {
  it('infers record types from a definition', () => {
    expectTypeOf<InferRecord<Def>>().toEqualTypeOf<{ title: string; tags?: string[] }>();
  });

  it('requires mutationId on every write (R5.4)', () => {
    // Compile-time only: the function is never called, so no runtime error can occur.
    const check = (col: Collection<{ title: string }>): void => {
      // Calling without options must be a type error.
      // @ts-expect-error mutationId is required
      void col.create({ title: 'x' });
      // @ts-expect-error mutationId is required
      void col.update('r', { title: 'y' });
      // @ts-expect-error mutationId is required
      void col.delete('r');
      // Options without a mutationId are rejected too.
      // @ts-expect-error mutationId is required
      void col.create({ title: 'x' }, {});
      void col.create({ title: 'x' }, { mutationId: 'form-1' });
    };
    expect(typeof check).toBe('function');
  });

  it('makes the reason code mandatory for every partial sync result', () => {
    const base = { rounds: 1, pulled: 0, pushed: 0, duplicates: 0, promoted: 0 };
    const partialNoCode = {
      ...base,
      status: 'partial',
      blocked: [],
      rejectedOrigins: [],
    } as const;
    // @ts-expect-error a partial result needs a reason code
    const bad: SyncResult = partialNoCode;
    void bad;

    const emptyBlocked = {
      ...base,
      status: 'partial',
      code: 'PEER_SCHEMA_OLDER',
      blocked: [],
      rejectedOrigins: [],
    } as const;
    // @ts-expect-error PEER_SCHEMA_OLDER needs at least one blocked origin
    const bad2: SyncResult = emptyBlocked;
    void bad2;
  });
});

describe('contract freeze: runtime pieces', () => {
  it('has stable error codes', () => {
    expect(ERROR_CODES).toContain('MUTATION_ID_REUSED');
    expect(ERROR_CODES).toContain('STORAGE_LOCK_LOST');
    const err = new WeaveError('VALIDATION_FAILED', 'bad', { details: { path: '$.a' } });
    expect(err.code).toBe('VALIDATION_FAILED');
    expect(err.details).toEqual({ path: '$.a' });
    expect(err).toBeInstanceOf(Error);
  });

  it('builds ASCII storage keys that sort numerically', () => {
    expect(padSeq(7)).toBe('000000000007');
    expect(keys.op('abc', 12)).toBe('op/abc/000000000012');
    expect(keys.op('abc', 2) < keys.op('abc', 10)).toBe(true);
    expect(keys.rop('c', 'r', 'o', 1)).toBe('rop/c/r/o/000000000001');
    expect(keys.pend('o', 3)).toBe('pend/o/000000000003');
    expect(keys.rec('c', 'r')).toBe('rec/c/r');
  });
});

import { describe, expect, it } from 'vitest';
import * as api from '../../src/index.js';
import { makeReplica, notes, syncPair } from '../engine/helpers.js';

describe('public API surface (R11.4, T1.A9)', () => {
  it('exports exactly the documented runtime symbols', () => {
    expect(Object.keys(api).sort()).toEqual([
      'ERROR_CODES',
      'WeaveError',
      'assertResolverDeterministic', // [ADV] 0.2.0, T5.4
      'createReplica',
      'defineCollection',
      'defineResolver', // [ADV] 0.2.0, T5.4
      'f',
      'isWeaveError',
      'newMutationId',
      'platformRandom',
      'randomFloat',
      'systemClock',
      'systemScheduler',
    ]);
  });

  it('reaches conflicts.current, conflicts.history and collection.history from a replica', async () => {
    const { replica } = await makeReplica();
    expect(typeof replica.conflicts.current).toBe('function');
    expect(typeof replica.conflicts.history).toBe('function');
    expect(typeof replica.collection(notes).history).toBe('function');
  });
});

describe('rebuild (R7.4, R6.13)', () => {
  it('leaves hashes, conflict view, history log and operation history unchanged', async () => {
    const a = await makeReplica();
    const b = await makeReplica();
    const { recordId } = await a.replica
      .collection(notes)
      .create({ title: 't' }, { mutationId: 'c' });
    await syncPair(a.replica, b.replica);
    await a.replica
      .collection(notes)
      .update(recordId, { title: 'A', priority: 1 }, { mutationId: 'a' });
    await b.replica
      .collection(notes)
      .update(recordId, { title: 'B', priority: 2 }, { mutationId: 'b' });
    await syncPair(a.replica, b.replica);
    const capture = async () => ({
      hashes: await a.replica.hashes(),
      current: await a.replica.conflicts.current(),
      history: await a.replica.conflicts.history(),
      ops: await a.replica.collection(notes).history(recordId),
    });
    const before = await capture();
    expect(before.current.length).toBeGreaterThan(0);
    await a.replica.rebuild();
    expect(await capture()).toEqual(before);
  });
});

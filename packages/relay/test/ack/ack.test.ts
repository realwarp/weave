/** Acknowledgement rules of design 10.3: a member's ack rises only by its AckRequest or its pushed prefix. */
import { describe, expect, it } from 'vitest';
import { makeOps } from '../../../testing/src/transport/index.js';
import { A, B, openRelay } from '../helpers.js';

const support = { notes: 1 };

describe('relay acknowledgements (design 10.3)', () => {
  it('push only: the pusher is acknowledged for the prefix it pushed', async () => {
    const { core } = await openRelay();
    await core.push({ replicaId: A, support, ops: await makeOps(A, 3) });
    expect(await core.memberAck(A)).toEqual({ [A]: 3 });
  });

  it('push with a gap: only the stored prefix counts', async () => {
    const { core } = await openRelay();
    const ops = await makeOps(A, 4);
    await core.push({ replicaId: A, support, ops: [ops[0]!, ops[2]!, ops[3]!] });
    expect(await core.memberAck(A)).toEqual({ [A]: 1 });
  });

  it('rejected push: the ack does not move', async () => {
    const { core } = await openRelay();
    const ops = await makeOps(A, 2);
    await expect(
      core.push({ replicaId: A, support, ops: [ops[0]!, ops[1]!.replace('"n":1', '"n":7')] }),
    ).rejects.toBeTruthy();
    expect(await core.memberAck(A)).toEqual({});
  });

  it('pull only: registers the member but never raises its ack', async () => {
    const { core } = await openRelay();
    await core.push({ replicaId: A, support, ops: await makeOps(A, 3) });
    const r = await core.pull({ replicaId: B, vector: {}, support, limit: 100 });
    expect(r.ops).toHaveLength(3);
    expect(await core.memberAck(B)).toEqual({});
  });

  it('pull then ack: the ack rises to what the member reports', async () => {
    const { core } = await openRelay();
    await core.push({ replicaId: A, support, ops: await makeOps(A, 3) });
    await core.pull({ replicaId: B, vector: {}, support, limit: 100 });
    await core.ack({ replicaId: B, durable: { [A]: 3 } });
    expect(await core.memberAck(B)).toEqual({ [A]: 3 });
  });

  it('pull then crash: no ack is recorded, before or after the relay restarts', async () => {
    const { core, backing } = await openRelay();
    await core.push({ replicaId: A, support, ops: await makeOps(A, 3) });
    await core.pull({ replicaId: B, vector: {}, support, limit: 100 });
    // B dies before sending its AckRequest; the relay process dies too (no close).
    backing.inUse = false;
    const { core: again } = await openRelay(backing);
    expect(await again.memberAck(B)).toEqual({});
    expect(await again.memberAck(A)).toEqual({ [A]: 3 });
  });

  it('out-of-order and repeated acks never lower the ack', async () => {
    const { core } = await openRelay();
    await core.ack({ replicaId: B, durable: { [A]: 5 } });
    await core.ack({ replicaId: B, durable: { [A]: 2 } });
    await core.ack({ replicaId: B, durable: { [A]: 5 } });
    expect(await core.memberAck(B)).toEqual({ [A]: 5 });
    await core.ack({ replicaId: B, durable: { [A]: 3, [B]: 1 } });
    expect(await core.memberAck(B)).toEqual({ [A]: 5, [B]: 1 });
  });

  it('acks survive a restart', async () => {
    const { core, backing } = await openRelay();
    await core.ack({ replicaId: B, durable: { [A]: 4 } });
    await core.close();
    const { core: again } = await openRelay(backing);
    expect(await again.memberAck(B)).toEqual({ [A]: 4 });
  });

  it('an unknown member has no ack entry', async () => {
    const { core } = await openRelay();
    expect(await core.memberAck(B)).toBeUndefined();
  });
});

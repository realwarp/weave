/**
 * A deterministic multi-replica simulator (design 12.2). It runs REAL replicas over in-memory
 * storage: they write, sync in random pairs, go offline and come back, and upgrade their schema.
 * Contexts, Lamport values, conflicts and pending buffers are therefore genuine.
 *
 * Everything is driven by one seed: the action schedule, every replica's `Random` (replica IDs,
 * record IDs, mutation IDs) and the written values. The same seed gives the same history log and
 * the same hashes. Wall time comes from a per-replica fake clock whose value is chosen by
 * `wallTime`, so the clock-independence property can run one schedule with wild clocks.
 */
import {
  createReplica,
  defineCollection,
  f,
  type Collection,
  type Hashes,
  type InferRecord,
  type Replica,
  type SyncEndpoint,
  type StorageAdapter,
  type SyncResult,
} from '@weave/core';
import { createMemoryBacking, memoryStorage, type MemoryBacking } from '@weave/storage/memory';
import {
  chance,
  fakeClock,
  fakeScheduler,
  randomInt,
  seededRandom,
  type FakeClock,
} from '../faults/random.js';

/** The simulator's collection, version 1. */
export const simNotesV1 = defineCollection({
  name: 'notes',
  version: 1,
  fields: {
    title: f.string({ required: true }),
    n: f.number({ resolver: 'max' }),
    tags: f.set(f.string()),
    status: f.rank(['open', 'active', 'done']),
  },
});

/** Version 2 adds an optional `note` field; the migration from version 1 keeps the fields. */
export const simNotesV2 = defineCollection({
  name: 'notes',
  version: 2,
  fields: {
    title: f.string({ required: true }),
    n: f.number({ resolver: 'max' }),
    tags: f.set(f.string()),
    status: f.rank(['open', 'active', 'done']),
    note: f.string(),
  },
  migrations: { 1: ({ fields }) => ({ ...fields }) },
});

type SimNote = InferRecord<typeof simNotesV2>;

export type Topology = 'mesh' | 'star' | 'line' | 'relay';

export interface SimulatorOptions {
  readonly seed: number | string;
  /** Number of replicas (default 3). */
  readonly replicas?: number;
  /**
   * Who may sync with whom: `mesh` any pair, `star` everyone with replica 0, `line` neighbours
   * only, `relay` everyone with `hub` only. Default `mesh`.
   */
  readonly topology?: Topology;
  /** The shared endpoint for the `relay` topology (for example a `RelayCore`). */
  readonly hub?: SyncEndpoint;
  /** Relative action weights. Defaults: write 6, sync 3, offline 1, upgrade 0. */
  readonly weights?: Partial<Record<'write' | 'sync' | 'offline' | 'upgrade', number>>;
  /** Wall time a replica's clock shows at a step (default: a steady clock, 1 s per step). */
  readonly wallTime?: (step: number, replica: number) => number;
  /** Maximum records written per replica before writes only update or delete (default 6). */
  readonly maxRecords?: number;
  /**
   * Storage for replica `name`, called on every (re)open. Default: memory storage over the
   * replica's `backing`. With custom storage, `opLines` is unavailable.
   */
  readonly storage?: (name: string) => StorageAdapter;
}

export interface SimReplica {
  readonly name: string;
  readonly backing: MemoryBacking;
  replica: Replica;
  online: boolean;
  upgraded: boolean;
  readonly clock: FakeClock;
}

export interface Simulator {
  readonly replicas: readonly SimReplica[];
  /** One line per action; equal seeds give equal logs. */
  readonly log: readonly string[];
  /** Runs `steps` random actions. */
  run(steps: number): Promise<void>;
  /** One random action. */
  step(): Promise<void>;
  /**
   * Brings every replica online, upgrades all of them if any is upgraded, then syncs along the
   * topology until every replica (and the hub) holds every op. Returns the number of sweeps.
   */
  converge(maxSweeps?: number): Promise<number>;
  hashes(): Promise<Hashes[]>;
  /** True when all replicas report equal state, op-set and conflict-view hashes. */
  converged(): Promise<boolean>;
  /** Accepted op lines of one replica, read directly from its storage, in key order. */
  opLines(index: number): string[];
  close(): Promise<void>;
}

const WORDS = ['alpha', 'bravo', 'delta', 'echo', 'kilo', 'lima', 'sierra', 'tango'];
const STATUS = ['open', 'active', 'done'] as const;

export async function createSimulator(options: SimulatorOptions): Promise<Simulator> {
  const count = options.replicas ?? 3;
  const topology = options.topology ?? 'mesh';
  if (count < 2) throw new Error('The simulator needs at least two replicas');
  if (topology === 'relay' && options.hub === undefined) {
    throw new Error('The relay topology needs a hub endpoint');
  }
  const random = seededRandom(`sim:${String(options.seed)}`);
  const weights = { write: 6, sync: 3, offline: 1, upgrade: 0, ...options.weights };
  const wallTime = options.wallTime ?? ((step: number) => 1_700_000_000_000 + step * 1000);
  const maxRecords = options.maxRecords ?? 6;
  const log: string[] = [];
  let stepNo = 0;
  let opened = 0;

  const open = async (
    sim: { backing: MemoryBacking; clock: FakeClock; name: string },
    upgraded: boolean,
  ) =>
    createReplica({
      storage: options.storage?.(sim.name) ?? memoryStorage({ backing: sim.backing }),
      collections: [upgraded ? simNotesV2 : simNotesV1],
      random: seededRandom(`sim:${String(options.seed)}:${sim.name}:${opened++}`),
      clock: sim.clock,
      scheduler: fakeScheduler(),
    });

  const replicas: SimReplica[] = [];
  for (let i = 0; i < count; i++) {
    const base = {
      name: `r${i}`,
      backing: createMemoryBacking(),
      clock: fakeClock(wallTime(0, i)),
    };
    replicas.push({ ...base, replica: await open(base, false), online: true, upgraded: false });
  }

  const col = (r: SimReplica): Collection<SimNote> =>
    r.replica.collection(r.upgraded ? simNotesV2 : simNotesV1) as unknown as Collection<SimNote>;

  const word = () => WORDS[randomInt(random, WORDS.length)]!;

  function patch(upgraded: boolean): Partial<SimNote> {
    const p: Record<string, unknown> = {};
    if (chance(random, 0.5)) p['title'] = `${word()} ${randomInt(random, 100)}`;
    if (chance(random, 0.4)) p['n'] = randomInt(random, 50);
    if (chance(random, 0.3))
      p['tags'] = [word(), word()].filter((v, i, a) => a.indexOf(v) === i).sort();
    if (chance(random, 0.3)) p['status'] = STATUS[randomInt(random, STATUS.length)];
    if (upgraded && chance(random, 0.3)) p['note'] = word();
    if (Object.keys(p).length === 0) p['n'] = randomInt(random, 50);
    return p as Partial<SimNote>;
  }

  async function write(r: SimReplica): Promise<void> {
    r.clock.set(wallTime(stepNo, replicas.indexOf(r)));
    const c = col(r);
    const existing = await c.query();
    const mutationId = r.replica.newMutationId();
    const roll = randomInt(random, 10);
    if (existing.length === 0 || (existing.length < maxRecords && roll < 3)) {
      const { recordId } = await c.create({ title: word(), ...patch(r.upgraded) } as SimNote, {
        mutationId,
      });
      log.push(`#${stepNo} ${r.name} create ${recordId}`);
      return;
    }
    const target = existing[randomInt(random, existing.length)]!;
    if (roll === 9) {
      await c.delete(target.id, { mutationId });
      log.push(`#${stepNo} ${r.name} delete ${target.id}`);
      return;
    }
    const p = patch(r.upgraded);
    await c.update(target.id, p, { mutationId });
    log.push(`#${stepNo} ${r.name} update ${target.id} ${JSON.stringify(p)}`);
  }

  const describe = (result: SyncResult): string =>
    result.status === 'complete' ? 'complete' : `${result.status}:${result.code}`;

  async function syncPair(a: SimReplica, b: SimReplica | 'hub'): Promise<string> {
    if (b === 'hub') return describe(await a.replica.sync(options.hub!));
    const r1 = await a.replica.sync(b.replica.endpoint());
    const r2 = await b.replica.sync(a.replica.endpoint());
    return `${describe(r1)}/${describe(r2)}`;
  }

  /** The partners a replica may sync with under the topology. */
  function partners(i: number): Array<number | 'hub'> {
    switch (topology) {
      case 'relay':
        return ['hub'];
      case 'star':
        return i === 0 ? replicas.map((_, j) => j).filter((j) => j !== 0) : [0];
      case 'line':
        return [i - 1, i + 1].filter((j) => j >= 0 && j < count);
      case 'mesh':
        return replicas.map((_, j) => j).filter((j) => j !== i);
    }
  }

  async function upgrade(r: SimReplica): Promise<void> {
    if (r.upgraded) return;
    await r.replica.close();
    r.upgraded = true;
    r.replica = await open(r, true);
    log.push(`#${stepNo} ${r.name} upgrade`);
  }

  async function step(): Promise<void> {
    stepNo++;
    const total = weights.write + weights.sync + weights.offline + weights.upgrade;
    let pick = randomInt(random, Math.max(1, total));
    const r = replicas[randomInt(random, count)]!;
    if ((pick -= weights.write) < 0) return write(r);
    if ((pick -= weights.sync) < 0) {
      const options = partners(replicas.indexOf(r));
      const other = options[randomInt(random, options.length)]!;
      const peer = other === 'hub' ? 'hub' : replicas[other]!;
      if (!r.online || (peer !== 'hub' && !peer.online)) {
        log.push(`#${stepNo} ${r.name} sync skipped (offline)`);
        return;
      }
      const outcome = await syncPair(r, peer);
      log.push(`#${stepNo} ${r.name} sync ${peer === 'hub' ? 'hub' : peer.name} ${outcome}`);
      return;
    }
    if ((pick -= weights.offline) < 0) {
      r.online = !r.online;
      log.push(`#${stepNo} ${r.name} ${r.online ? 'online' : 'offline'}`);
      return;
    }
    return upgrade(r);
  }

  async function hashes(): Promise<Hashes[]> {
    return Promise.all(replicas.map((r) => r.replica.hashes()));
  }

  async function converged(): Promise<boolean> {
    const all = (await hashes()).map((h) => JSON.stringify(h));
    return all.every((h) => h === all[0]);
  }

  async function converge(maxSweeps = 2 * count + 2): Promise<number> {
    for (const r of replicas) r.online = true;
    if (replicas.some((r) => r.upgraded)) for (const r of replicas) await upgrade(r);
    for (let sweep = 1; sweep <= maxSweeps; sweep++) {
      // A forward and a backward pass along every allowed edge carries each op end to end.
      const order = [...replicas.keys(), ...[...replicas.keys()].reverse()];
      for (const i of order) {
        for (const j of partners(i)) {
          if (j === 'hub') await syncPair(replicas[i]!, 'hub');
          else if (j > i) await syncPair(replicas[i]!, replicas[j]!);
        }
      }
      if (await converged()) {
        log.push(`converged after ${sweep} sweep(s)`);
        return sweep;
      }
    }
    log.push(`not converged after ${maxSweeps} sweeps`);
    return maxSweeps;
  }

  function opLines(index: number): string[] {
    if (options.storage !== undefined) throw new Error('opLines needs the default memory storage');
    const store = replicas[index]!.backing.store;
    return store.keysFrom('op/').map((k) => store.get(k)!);
  }

  return {
    replicas,
    log,
    run: async (steps) => {
      for (let i = 0; i < steps; i++) await step();
    },
    step,
    converge,
    hashes,
    converged,
    opLines,
    close: async () => {
      for (const r of replicas) await r.replica.close();
    },
  };
}

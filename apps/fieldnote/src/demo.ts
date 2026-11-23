/**
 * FIELDNOTE scripted demo (design 13.2, R14.5, R14.7). Workers on file storage sync through a real
 * relay process. Run it with `npm run demo:fieldnote`, which starts the relay and sets
 * WEAVE_RELAY_URL and WEAVE_DEMO_DIR.
 *
 * Part 1: three workers record inspections under schema v1 (cho stays offline for a long time),
 * all three upgrade to v2, keep working, sync and print equal hashes.
 * Part 2: a v1-only device pulls from the relay, receives only the readable prefix of each origin
 * and reports `partial / PEER_SCHEMA_OLDER`; after its upgrade it converges with everyone.
 */
import { createReplica } from '@weave/core';
import { fileStorage } from '@weave/storage/file';
import { httpTransport } from '@weave/transport/http';
import {
  addObservation,
  assign,
  conflictHistory,
  createInspection,
  editInspection,
  editObservation,
  inspectionHistory,
  listInspections,
  observationsOf,
  setStatus,
  type Session,
} from './logic.js';
import { collectionsV1, collectionsV2, observations } from './model.js';
import { memoryPending, runAction } from './pending.js';

const relayUrl = process.env['WEAVE_RELAY_URL'];
const dir = process.env['WEAVE_DEMO_DIR'];
if (relayUrl === undefined || dir === undefined) {
  throw new Error(
    'Run through `npm run demo:fieldnote` (needs WEAVE_RELAY_URL and WEAVE_DEMO_DIR)',
  );
}
const token = process.env['WEAVE_RELAY_TOKEN'];
const relay = () => httpTransport({ baseUrl: relayUrl, ...(token ? { token } : {}) });
const step = (id: string, text: string) => console.log(`\n[step ${id}] ${text}`);

async function open(user: string, version: 1 | 2): Promise<Session> {
  const replica = await createReplica({
    storage: fileStorage({ dir: `${dir}/${user}` }),
    collections: version === 1 ? collectionsV1 : collectionsV2,
  });
  return { replica, pending: memoryPending(), user, version };
}

async function upgrade(s: Session): Promise<Session> {
  await s.replica.close();
  const next = await open(s.user, 2);
  console.log(`  ${s.user.padEnd(4)} reopened with inspections v2`);
  return next;
}

async function sync(s: Session, expect: 'complete' | 'partial' = 'complete') {
  const r = await s.replica.sync(relay());
  const detail = r.status === 'partial' ? ` / ${r.code}` : '';
  console.log(`  ${s.user.padEnd(4)} sync -> ${r.status}${detail}`);
  if (r.status !== expect) throw new Error(`${s.user}: expected ${expect}, got ${r.status}`);
  return r;
}

async function printHashes(list: Session[]): Promise<void> {
  const all = await Promise.all(list.map((d) => d.replica.hashes()));
  list.forEach((d, i) =>
    console.log(
      `  ${d.user.padEnd(4)} state ${all[i]!.state.slice(0, 16)}  ops ${all[i]!.ops.slice(0, 16)}  conflicts ${all[i]!.conflicts.slice(0, 16)}`,
    ),
  );
  const same = all.every((h) => JSON.stringify(h) === JSON.stringify(all[0]));
  console.log(`  all hashes equal: ${same}`);
  if (!same) throw new Error('hashes differ');
}

// ---------------------------------------------------------------- part 1

let ana = await open('ana', 1);
let ben = await open('ben', 1);
let cho = await open('cho', 1);

step('v1-work', 'Three workers record inspections under schema v1');
const bridge = await createInspection(
  ana,
  'bridge',
  { title: 'Bridge 4', location: 'North / A3' },
  ['ana'],
);
const pump = await createInspection(ben, 'pump', { title: 'Pump house', location: 'West yard' }, [
  'ben',
]);
const crack = await addObservation(ben, 'crack', bridge.recordId, {
  note: 'Hairline crack, east pier',
  severity: 2,
  reading: 0.4,
});
await sync(ana);
await sync(ben);
await sync(ana);
// cho syncs once, then goes offline for a long time.
await sync(cho);
console.log('  cho goes offline');

step('upgrade', 'Everyone upgrades to inspections v2 (location -> site / zone)');
ana = await upgrade(ana);
ben = await upgrade(ben);
cho = await upgrade(cho);
for (const r of await listInspections(ana))
  console.log(`  ana sees "${r.title}" at site/zone "${r.where}"`);

step('concurrent', 'Concurrent edits; cho works offline');
await editInspection(ana, bridge.recordId, { title: 'Bridge 4 (east span)' });
await editInspection(ben, bridge.recordId, { zone: 'A4' });
console.log('  fields: ana renames the bridge, ben corrects its zone');
await setStatus(ana, bridge.recordId, 'in_review');
await setStatus(cho, bridge.recordId, 'closed');
console.log('  status: ana sets in_review, cho (offline) sets closed');
await editObservation(ben, crack.recordId, { severity: 3 });
await editObservation(cho, crack.recordId, { severity: 4, reading: 0.7 });
console.log('  severity: ben says 3, cho (offline) says 4');
await assign(cho, pump.recordId, ['cho']);
await sync(ana);
await sync(ben);
await sync(ana);

step('reconnect', 'cho comes back online after a long time');
await sync(cho);
await sync(ana);
await sync(ben);

step('hashes', 'Part 1: all v2 workers hold the same state');
await printHashes([ana, ben, cho]);

step('result', 'What everyone sees');
const row = (await listInspections(cho)).find((r) => r.id === bridge.recordId)!;
console.log(`  fields: "${row.title}" at "${row.where}" (both edits kept)`);
console.log(`  status: ${row.status} (the more advanced status wins)`);
const [obs] = await observationsOf(ana, bridge.recordId);
console.log(`  severity: ${obs?.severity} (the higher severity wins), reading ${obs?.reading}`);
console.log(
  `  assignees of "Pump house": ${JSON.stringify((await listInspections(ana)).find((r) => r.id === pump.recordId)?.assignees)}`,
);

step('conflicts', 'Conflict history view');
for (const c of await conflictHistory(ana)) {
  console.log(
    `  ${c.collection}/${c.field.padEnd(8)} values ${JSON.stringify(c.values)} -> ${c.resolved} (${c.status})`,
  );
}

step('history', 'Operation history of "Bridge 4", as written');
for (const h of await inspectionHistory(ana, bridge.recordId)) {
  console.log(
    `  v${h.schemaVersion} ${h.kind} ${JSON.stringify(h.fields)}${h.concurrentWith ? ` (concurrent with ${h.concurrentWith})` : ''}`,
  );
}

step('replay', 'A write repeated with its stored mutationId after a simulated crash');
await runAction(ana.replica, ana.pending, `obs-note:${crack.recordId}`, async (mutationId) => {
  await ana.replica
    .collection(observations)
    .update(crack.recordId, { note: 'Crack measured, east pier' }, { mutationId });
  console.log(
    `  ana: wrote with mutationId ${mutationId}, then the app crashed before recording the result`,
  );
  return Promise.reject(new Error('simulated crash'));
}).catch(() => undefined);
const retry = await runAction(
  ana.replica,
  ana.pending,
  `obs-note:${crack.recordId}`,
  (mutationId) =>
    ana.replica
      .collection(observations)
      .update(crack.recordId, { note: 'Crack measured, east pier' }, { mutationId }),
);
console.log(`  ana: retried with the stored mutationId -> replayed: ${retry.replayed}`);
if (!retry.replayed) throw new Error('the retry was not replayed');
await sync(ana);
await sync(ben);
await sync(cho);

// ---------------------------------------------------------------- part 2

step('v1-only', 'Part 2: a device that still runs schema v1 joins');
let dan = await open('dan', 1);
const partial = await sync(dan, 'partial');
for (const b of partial.blocked) {
  console.log(
    `  blocked: origin ${b.origin.slice(0, 8)}... at seq ${b.seq} needs ${b.collection} v${b.requiredVersion}`,
  );
}
for (const r of await listInspections(dan))
  console.log(`  dan (v1) sees "${r.title}" at "${r.where}" (readable prefix only)`);

step('v1-upgrade', 'dan upgrades and converges');
dan = await upgrade(dan);
await sync(dan);
await printHashes([ana, ben, cho, dan]);

for (const s of [ana, ben, cho, dan]) await s.replica.close();
console.log('\nFIELDNOTE demo finished: all workers converged.');

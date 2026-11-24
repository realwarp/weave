/**
 * GHOSTLINE scripted demo (design 13.1, R13.6). Three devices on file storage sync through a real
 * relay process. Run it with `npm run demo:ghostline`, which starts the relay and sets
 * WEAVE_RELAY_URL and WEAVE_DEMO_DIR.
 *
 * Steps: everyone creates content offline; devices sync; two people claim one request, two tag it,
 * one deletes an announcement another is editing; devices sync in a chosen order; the demo prints
 * every device's hashes and asserts they are equal, prints the notices, and finally repeats a write
 * with its stored mutationId after a simulated crash (`replayed: true`).
 */
import { createReplica } from '@weave/core';
import { fileStorage } from '@weave/storage/file';
import { httpTransport } from '@weave/transport/http';
import {
  claimRequest,
  createRequest,
  deleteAnnouncement,
  draftAnnouncement,
  editAnnouncement,
  listAnnouncements,
  listRequests,
  notices,
  publishAnnouncement,
  tagRequest,
  type Session,
} from './logic.js';
import { collections, requests } from './model.js';
import { memoryPending, runAction } from './pending.js';

const relayUrl = process.env['WEAVE_RELAY_URL'];
const dir = process.env['WEAVE_DEMO_DIR'];
if (relayUrl === undefined || dir === undefined) {
  throw new Error(
    'Run through `npm run demo:ghostline` (needs WEAVE_RELAY_URL and WEAVE_DEMO_DIR)',
  );
}
const token = process.env['WEAVE_RELAY_TOKEN'];
const relay = () => httpTransport({ baseUrl: relayUrl, ...(token ? { token } : {}) });

const step = (id: string, text: string) => console.log(`\n[step ${id}] ${text}`);

async function device(user: string): Promise<Session> {
  const replica = await createReplica({
    storage: fileStorage({ dir: `${dir}/${user}` }),
    collections,
  });
  return { replica, pending: memoryPending(), user };
}

async function sync(s: Session): Promise<void> {
  const r = await s.replica.sync(relay());
  console.log(`  ${s.user.padEnd(4)} sync -> ${r.status}`);
  if (r.status !== 'complete') throw new Error(`${s.user}: sync was not complete`);
}

async function printHashes(devices: Session[]): Promise<void> {
  const all = await Promise.all(devices.map((d) => d.replica.hashes()));
  devices.forEach((d, i) =>
    console.log(
      `  ${d.user.padEnd(4)} state ${all[i]!.state.slice(0, 16)}  ops ${all[i]!.ops.slice(0, 16)}  conflicts ${all[i]!.conflicts.slice(0, 16)}`,
    ),
  );
  const same = all.every((h) => JSON.stringify(h) === JSON.stringify(all[0]));
  console.log(`  all hashes equal: ${same}`);
  if (!same) throw new Error('hashes differ');
}

const ana = await device('ana');
const ben = await device('ben');
const cho = await device('cho');
const everyone = [ana, ben, cho];

step('offline', 'Everyone creates content while offline');
const market = await draftAnnouncement(ana, 'market', 'Market day', 'Saturday on the square');
await publishAnnouncement(ana, market.recordId);
const firewood = await createRequest(
  ben,
  'firewood',
  'Firewood for Mrs. Lee',
  'She is out of wood',
  ['winter'],
);
const cleanup = await draftAnnouncement(cho, 'cleanup', 'Park cleanup', 'Sunday 10am');
console.log('  ana: published "Market day"; ben: asked for firewood; cho: drafted "Park cleanup"');

step('first-sync', 'Devices come online and sync through the relay');
for (const d of [ana, ben, cho, ana]) await sync(d);

step('concurrent', 'Concurrent edits while offline again');
await claimRequest(ana, firewood.recordId);
await claimRequest(ben, firewood.recordId);
console.log('  claim: ana and ben both claim the firewood request');
await tagRequest(ana, firewood.recordId, ['urgent']);
await tagRequest(cho, firewood.recordId, ['heavy']);
console.log('  tags: ana adds "urgent", cho adds "heavy"');
await deleteAnnouncement(ana, cleanup.recordId);
await editAnnouncement(cho, cleanup.recordId, { body: 'Sunday 10am, bring gloves' });
console.log('  delete-edit: ana deletes "Park cleanup" while cho edits it');

step('ordered-sync', 'Sync in the order cho, ben, ana, cho, ben');
for (const d of [cho, ben, ana, cho, ben]) await sync(d);

step('hashes', 'Every device holds the same state');
await printHashes(everyone);

step('result', 'What everyone sees');
const req = (await listRequests(cho))[0]!.value;
console.log(`  claim: claimedBy = ${req.claimedBy} (one claimant, chosen the same way everywhere)`);
console.log(`  tags: ${JSON.stringify(req.tags)} (both tag edits kept)`);
console.log(
  `  publish: "Market day" status = ${(await listAnnouncements(ben)).find((a) => a.id === market.recordId)?.value.status}`,
);
console.log(
  `  delete-edit: "Park cleanup" exists = ${(await listAnnouncements(cho)).some((a) => a.id === cleanup.recordId)} (the delete wins)`,
);

step('notices', 'Notices built from the conflict history');
for (const d of everyone) {
  const list = await notices(d);
  for (const n of list) console.log(`  ${d.user.padEnd(4)} ${n.kind.padEnd(16)} ${n.message}`);
  if (list.length === 0) console.log(`  ${d.user.padEnd(4)} (no notices)`);
}

step('replay', 'A write repeated with its stored mutationId after a simulated crash');
const before = await ben.replica.hashes();
await runAction(ben.replica, ben.pending, `fulfil:${firewood.recordId}`, async (mutationId) => {
  await ben.replica
    .collection(requests)
    .update(firewood.recordId, { state: 'fulfilled' }, { mutationId });
  console.log(
    `  ben: wrote with mutationId ${mutationId}, then the app crashed before recording the result`,
  );
  return Promise.reject(new Error('simulated crash'));
}).catch(() => undefined);
const changed = await ben.replica.hashes();
const retry = await runAction(
  ben.replica,
  ben.pending,
  `fulfil:${firewood.recordId}`,
  (mutationId) =>
    ben.replica
      .collection(requests)
      .update(firewood.recordId, { state: 'fulfilled' }, { mutationId }),
);
console.log(`  ben: retried with the stored mutationId -> replayed: ${retry.replayed}`);
const after = await ben.replica.hashes();
if (
  !retry.replayed ||
  JSON.stringify(after) !== JSON.stringify(changed) ||
  JSON.stringify(after) === JSON.stringify(before)
) {
  throw new Error('the retry was not an idempotent replay');
}
// ben pushes the fulfilment first, then the others pick it up.
for (const d of [ben, ana, cho]) await sync(d);
await printHashes(everyone);

for (const d of everyone) await d.replica.close();
console.log('\nGHOSTLINE demo finished: all devices converged.');

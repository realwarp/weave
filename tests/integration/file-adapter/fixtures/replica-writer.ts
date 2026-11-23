// Child process for the engine kill test: a replica on file storage creates records until killed.
// Mutation IDs are `m-<i>`, so the parent can retry the last intent after the crash.
import { createReplica } from '../../../../packages/core/src/index.js';
import { fileStorage } from '../../../../packages/storage/src/file/index.js';
import { simNotesV1 } from '../../../../packages/testing/src/simulator/index.js';

const dir = process.argv[2];
if (dir === undefined) throw new Error('usage: replica-writer <dir>');
const replica = await createReplica({
  storage: fileStorage({ dir, rotateBytes: 16_384 }),
  collections: [simNotesV1],
});
const notes = replica.collection(simNotesV1);
for (let i = 0; ; i++) {
  await notes.create({ title: `note ${i}`, n: i }, { mutationId: `m-${i}` });
  if (i % 5 === 0) process.stdout.write(`${i}\n`);
}

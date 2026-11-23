// Child process for the kill test: writes transactions forever until killed.
import { fileStorage } from '../../../src/file/index.js';

const dir = process.argv[2];
if (dir === undefined) throw new Error('usage: writer <dir>');
const storage = fileStorage({ dir });
await storage.open();
for (let i = 0; ; i++) {
  await storage.transaction('rw', async (tx) => {
    tx.put(`k/${String(i).padStart(6, '0')}`, `v${i}`);
    tx.put('count', String(i + 1));
  });
  if (i % 10 === 0) process.stdout.write(`${i}\n`);
}

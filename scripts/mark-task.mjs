// Marks tasks as done in the approved spec: node scripts/mark-task.mjs T0.3 T0.4
import fs from 'node:fs';

const file = '.kiro/specs/mission-build-weave-an-offline-first/tasks.md';
let text = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
for (const id of process.argv.slice(2)) {
  const open = `- [ ] **${id} `;
  if (text.includes(open)) {
    text = text.replace(open, `- [x] **${id} `);
    console.log(`marked ${id}`);
  } else {
    console.log(`not found or already marked: ${id}`);
  }
}
fs.writeFileSync(file, text);

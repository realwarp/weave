// Reproducible build check (R20.2): build twice from a clean state and compare output hashes.
import { createHash } from 'node:crypto';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

function listFiles(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules') continue;
      listFiles(full, out);
    } else if (
      /(\.js|\.d\.ts|\.js\.map|\.d\.ts\.map)$/.test(entry.name) &&
      full.includes(`${path.sep}dist${path.sep}`)
    ) {
      out.push(full);
    }
  }
  return out;
}

function buildAndHash() {
  for (const pkg of fs.readdirSync('packages')) {
    fs.rmSync(path.join('packages', pkg, 'dist'), { recursive: true, force: true });
    for (const f of fs.readdirSync(path.join('packages', pkg))) {
      if (f.endsWith('.tsbuildinfo')) fs.rmSync(path.join('packages', pkg, f));
    }
  }
  execSync('npx tsc --build --force', { stdio: 'inherit' });
  const hash = createHash('sha256');
  for (const file of listFiles('packages').sort()) {
    hash.update(file.split(path.sep).join('/'));
    hash.update(fs.readFileSync(file));
  }
  return hash.digest('hex');
}

const first = buildAndHash();
const second = buildAndHash();
console.log(`build 1: ${first}\nbuild 2: ${second}`);
if (first !== second) {
  console.error('Builds differ: the build is not reproducible.');
  process.exit(1);
}
console.log('Reproducible build check passed.');

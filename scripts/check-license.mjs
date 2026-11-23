// License check (R19.1, R19.2): MIT LICENSE at the root, every package.json says MIT, and the
// `.kiro` directory is not ignored. Usage: node scripts/check-license.mjs [--root <dir>]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function checkLicense(root) {
  const problems = [];
  const licensePath = path.join(root, 'LICENSE');
  if (!fs.existsSync(licensePath)) problems.push('LICENSE file is missing');
  else if (!/^MIT License/m.test(fs.readFileSync(licensePath, 'utf8'))) {
    problems.push('LICENSE is not the MIT license');
  }
  const manifests = [path.join(root, 'package.json')];
  for (const group of ['packages', 'apps']) {
    const dir = path.join(root, group);
    if (!fs.existsSync(dir)) continue;
    for (const name of fs.readdirSync(dir)) {
      const file = path.join(dir, name, 'package.json');
      if (fs.existsSync(file)) manifests.push(file);
    }
  }
  for (const file of manifests) {
    const pkg = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (pkg.license !== 'MIT') problems.push(`${path.relative(root, file)}: license is not MIT`);
  }
  const ignorePath = path.join(root, '.gitignore');
  if (fs.existsSync(ignorePath)) {
    const lines = fs
      .readFileSync(ignorePath, 'utf8')
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('#'));
    if (lines.some((l) => /^\/?\.kiro\/?\*?\*?$/.test(l)))
      problems.push('.gitignore must not list .kiro');
  }
  return problems;
}

const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  const flag = process.argv.indexOf('--root');
  const root = path.resolve(flag >= 0 ? process.argv[flag + 1] : '.');
  const problems = checkLicense(root);
  if (problems.length > 0) {
    for (const p of problems) console.error(`  - ${p}`);
    process.exit(1);
  }
  console.log('License check passed.');
}

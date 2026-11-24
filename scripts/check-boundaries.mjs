// Boundary checks (design 2, R14a.1, R4a.6, R9.4). Parses TypeScript with the compiler API.
//
//  1. @weave/core source imports no `node:*` module and no other workspace package.
//  2. @weave/relay source never imports resolver, schema, migration or state modules, and imports
//     @weave/core only through `@weave/core/protocol`.
//  3. Apps import only public entry points (`@weave/core`, `@weave/storage/*`, `@weave/transport/*`,
//     `@weave/relay`), never relative paths into packages/, and never use the identifiers
//     lamport, context, sha256, canonical, versionVector, frontier (no sync code in apps).
//  4. No `Math.random` anywhere in packages/*/src.
//
// Usage: node scripts/check-boundaries.mjs [--root <dir>]   (exit code 1 on any violation)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const FORBIDDEN_APP_IDENTIFIERS = new Set([
  'lamport',
  'context',
  'sha256',
  'canonical',
  'versionVector',
  'frontier',
]);
const APP_ALLOWED_PREFIXES = [
  '@weave/core',
  '@weave/storage/',
  '@weave/transport/',
  '@weave/relay',
];
const INTERNAL_WORDS =
  /(^|[\\/])(resolvers?|schema|migrations?|state|engine|canonical|ops)([\\/]|$)/;

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (['node_modules', 'dist', 'coverage', '.vite'].includes(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (/\.(ts|tsx|mts)$/.test(entry.name) && !entry.name.endsWith('.d.ts')) out.push(full);
  }
  return out;
}

/**
 * Documented fields of the public API that apps may READ even though the name is otherwise
 * forbidden (design 2, amended in 0.1.x): `ConflictRecord.frontier` lists the competing ops of a
 * conflict, which notice and conflict-history views must show. Only the property-access form
 * `x.frontier` is allowed; declaring, importing or otherwise naming `frontier` stays a violation.
 */
const PUBLIC_FIELD_READS = new Set(['frontier']);

function isPublicFieldRead(node) {
  const parent = node.parent;
  return (
    PUBLIC_FIELD_READS.has(node.text) &&
    parent !== undefined &&
    ts.isPropertyAccessExpression(parent) &&
    parent.name === node
  );
}

function analyse(file) {
  const text = fs.readFileSync(file, 'utf8');
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.ES2022, true);
  const imports = [];
  const identifiers = [];
  const mathRandom = [];
  const visit = (node) => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      imports.push(node.moduleSpecifier.text);
    }
    if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments[0] &&
      ts.isStringLiteral(node.arguments[0])
    ) {
      imports.push(node.arguments[0].text);
    }
    if (ts.isIdentifier(node) && !isPublicFieldRead(node)) identifiers.push(node.text);
    if (
      ts.isPropertyAccessExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'Math' &&
      node.name.text === 'random'
    ) {
      mathRandom.push(source.getLineAndCharacterOfPosition(node.getStart()).line + 1);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return { imports, identifiers: new Set(identifiers), mathRandom };
}

export function checkBoundaries(root) {
  const violations = [];
  const rel = (f) => path.relative(root, f).split(path.sep).join('/');
  const add = (file, message) => violations.push(`${rel(file)}: ${message}`);

  const packagesDir = path.join(root, 'packages');
  if (fs.existsSync(packagesDir)) {
    for (const pkg of fs.readdirSync(packagesDir)) {
      for (const file of walk(path.join(packagesDir, pkg, 'src'))) {
        const info = analyse(file);
        for (const line of info.mathRandom)
          add(file, `Math.random at line ${line} (use the injected Random)`);
        if (pkg === 'core') {
          for (const spec of info.imports) {
            if (spec.startsWith('node:')) add(file, `core must not import ${spec}`);
            else if (spec.startsWith('@weave/')) add(file, `core must not import ${spec}`);
            else if (!spec.startsWith('.'))
              add(file, `core must have no runtime dependency: ${spec}`);
          }
        }
        if (pkg === 'relay') {
          for (const spec of info.imports) {
            if (spec === '@weave/core') add(file, 'relay may import only @weave/core/protocol');
            if (
              spec.startsWith('.') &&
              INTERNAL_WORDS.test(spec) &&
              /(resolver|schema|migrat|state|derive)/.test(spec)
            ) {
              add(file, `relay must not import ${spec} (semantically opaque, R4a.6)`);
            }
            if (/@weave\/core\/(?!protocol)/.test(spec)) add(file, `relay must not import ${spec}`);
          }
        }
      }
    }
  }

  const appsDir = path.join(root, 'apps');
  if (fs.existsSync(appsDir)) {
    for (const app of fs.readdirSync(appsDir)) {
      for (const file of walk(path.join(appsDir, app, 'src'))) {
        const info = analyse(file);
        for (const spec of info.imports) {
          if (spec.startsWith('.')) {
            const target = path.resolve(path.dirname(file), spec);
            if (path.relative(path.join(root, 'apps', app), target).startsWith('..')) {
              add(file, `app imports outside itself: ${spec}`);
            }
          } else if (spec.startsWith('@weave/')) {
            if (!APP_ALLOWED_PREFIXES.some((p) => spec === p || spec.startsWith(p))) {
              add(file, `app imports a non-public entry point: ${spec}`);
            }
            if (/@weave\/core\/(?!$)/.test(spec) || /\/(src|dist)\//.test(spec)) {
              add(file, `app imports an internal module: ${spec}`);
            }
          }
          if (/(^|\/)packages\//.test(spec)) add(file, `app imports into packages/: ${spec}`);
        }
        for (const id of FORBIDDEN_APP_IDENTIFIERS) {
          if (info.identifiers.has(id)) add(file, `app uses forbidden sync identifier "${id}"`);
        }
      }
    }
  }
  return violations;
}

const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  const flag = process.argv.indexOf('--root');
  const root = path.resolve(flag >= 0 ? process.argv[flag + 1] : '.');
  const violations = checkBoundaries(root);
  if (violations.length > 0) {
    console.error(`Boundary violations (${violations.length}):`);
    for (const v of violations) console.error(`  - ${v}`);
    process.exit(1);
  }
  console.log('Boundary check passed.');
}

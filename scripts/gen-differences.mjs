// Generates the app differences table (R14a.3, design 13.3) from each app's `src/model.ts`.
//
//   node scripts/gen-differences.mjs           print the table
//   node scripts/gen-differences.mjs --write   write docs/app-differences.md
//   node scripts/gen-differences.mjs --check   fail when docs/app-differences.md is out of date
//
// The table is built from the `defineCollection` calls with the TypeScript compiler API, so it
// cannot drift from the code. Every field carries a `@demo <step>` JSDoc tag naming the demo step
// that prints its behaviour; the script fails when a field has no tag or the step does not exist
// in the app's `src/demo.ts`.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const APPS = [
  {
    dir: 'ghostline',
    title: 'GHOSTLINE',
    workflow: 'publish and claim: announcements and help requests',
  },
  {
    dir: 'fieldnote',
    title: 'FIELDNOTE',
    workflow: 'structured record review: inspections and observations',
  },
];

const RULES = {
  'last-writer-wins': 'last writer wins',
  max: 'highest value wins',
  min: 'lowest value wins',
  'set-union': 'union, nothing lost',
  'max-rank': 'most advanced value wins',
};

function literal(node, consts) {
  if (node === undefined) return undefined;
  if (
    ts.isAsExpression(node) ||
    ts.isParenthesizedExpression(node) ||
    ts.isSatisfiesExpression?.(node)
  )
    return literal(node.expression, consts);
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isNumericLiteral(node)) return Number(node.text);
  if (node.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (node.kind === ts.SyntaxKind.FalseKeyword) return false;
  if (ts.isArrayLiteralExpression(node)) return node.elements.map((e) => literal(e, consts));
  if (ts.isIdentifier(node) && consts.has(node.text)) return literal(consts.get(node.text), consts);
  if (ts.isObjectLiteralExpression(node)) {
    const out = {};
    for (const p of node.properties)
      if (ts.isPropertyAssignment(p)) out[p.name.getText()] = literal(p.initializer, consts);
    return out;
  }
  return undefined;
}

function prop(obj, name) {
  return obj.properties.find((p) => ts.isPropertyAssignment(p) && p.name.getText() === name);
}

/** Reads one model file: [{ collection, version, fields: [{ name, kind, rule, values, demo }] }]. */
export function readModel(file) {
  const source = ts.createSourceFile(
    file,
    fs.readFileSync(file, 'utf8'),
    ts.ScriptTarget.ES2022,
    true,
  );
  const consts = new Map();
  const collections = [];
  const visit = (node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer)
      consts.set(node.name.text, node.initializer);
    if (ts.isCallExpression(node) && node.expression.getText() === 'defineCollection') {
      const def = node.arguments[0];
      if (def && ts.isObjectLiteralExpression(def)) {
        const fieldsProp = prop(def, 'fields');
        const fields = [];
        if (fieldsProp && ts.isObjectLiteralExpression(fieldsProp.initializer)) {
          for (const p of fieldsProp.initializer.properties) {
            if (!ts.isPropertyAssignment(p) || !ts.isCallExpression(p.initializer)) continue;
            const call = p.initializer;
            const kind = call.expression.getText().replace(/^f\./, '');
            let rule;
            let values;
            if (kind === 'set') rule = 'set-union';
            else if (kind === 'rank') {
              rule = 'max-rank';
              values = literal(call.arguments[0], consts);
            } else {
              const opts = literal(call.arguments[0], consts);
              rule = (opts && opts.resolver) || 'last-writer-wins';
            }
            const demo = ts
              .getJSDocTags(p)
              .filter((t) => t.tagName.text === 'demo')
              .map((t) =>
                (typeof t.comment === 'string'
                  ? t.comment
                  : (ts.getTextOfJSDocComment(t.comment) ?? '')
                ).trim(),
              )[0];
            fields.push({ name: p.name.getText(), kind, rule, values, demo });
          }
        }
        collections.push({
          collection: literal(prop(def, 'name')?.initializer, consts),
          version: literal(prop(def, 'version')?.initializer, consts),
          fields,
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return collections;
}

function demoSteps(file) {
  const text = fs.readFileSync(file, 'utf8');
  return new Set([...text.matchAll(/step\('([^']+)'/g)].map((m) => m[1]));
}

/** Returns { markdown, problems }. */
export function generateDifferences(root) {
  const problems = [];
  const models = APPS.map((app) => {
    const dir = path.join(root, 'apps', app.dir, 'src');
    const collections = readModel(path.join(dir, 'model.ts'));
    const steps = demoSteps(path.join(dir, 'demo.ts'));
    for (const c of collections) {
      for (const f of c.fields) {
        if (!f.demo)
          problems.push(
            `${app.dir}: ${c.collection} v${c.version} field "${f.name}" has no @demo tag`,
          );
        else if (!steps.has(f.demo))
          problems.push(
            `${app.dir}: @demo ${f.demo} (field "${f.name}") is not a step in src/demo.ts`,
          );
      }
    }
    return { ...app, collections };
  });

  const lines = [
    '# GHOSTLINE and FIELDNOTE: how they differ',
    '',
    "<!-- Generated by `node scripts/gen-differences.mjs --write` from each app's src/model.ts. Do not edit by hand; CI runs --check. -->",
    '',
    'Both apps use only the public WEAVE API. They differ in their workflows and in the merge rule each',
    'field declares. Each row names the demo step (`npm run demo:<app>`, lines marked `[step <id>]`)',
    'whose output shows that rule at work.',
    '',
    '## Merge rules in use',
    '',
    '| Merge rule | ' + models.map((m) => m.title).join(' | ') + ' |',
    '| --- | ' + models.map(() => '---').join(' | ') + ' |',
  ];
  for (const rule of Object.keys(RULES)) {
    const cells = models.map((m) => {
      const used = m.collections.flatMap((c) =>
        c.fields.filter((f) => f.rule === rule).map((f) => `\`${c.collection}.${f.name}\``),
      );
      return [...new Set(used)].join(', ') || 'not used';
    });
    lines.push(`| \`${rule}\` (${RULES[rule]}) | ${cells.join(' | ')} |`);
  }
  for (const m of models) {
    lines.push(
      '',
      `## ${m.title}`,
      '',
      `Workflow: ${m.workflow}.`,
      '',
      '| Collection | Field | Merge rule | Demo step |',
      '| --- | --- | --- | --- |',
    );
    for (const c of m.collections) {
      for (const f of c.fields) {
        const rule =
          f.rule === 'max-rank' && Array.isArray(f.values)
            ? `max-rank: ${f.values.join(' < ')}`
            : f.rule;
        lines.push(
          `| \`${c.collection}\` v${c.version} | \`${f.name}\` | ${rule} | \`${f.demo ?? '?'}\` |`,
        );
      }
    }
  }
  return { markdown: `${lines.join('\n')}\n`, problems };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const target = path.join(root, 'docs', 'app-differences.md');
  const { markdown, problems } = generateDifferences(root);
  if (problems.length > 0) {
    for (const p of problems) console.error(`gen-differences: ${p}`);
    process.exit(1);
  }
  if (process.argv.includes('--write')) {
    fs.writeFileSync(target, markdown);
    console.log(`wrote ${path.relative(root, target)}`);
  } else if (process.argv.includes('--check')) {
    const current = fs.existsSync(target)
      ? fs.readFileSync(target, 'utf8').replace(/\r\n/g, '\n')
      : '';
    if (current !== markdown) {
      console.error(
        'docs/app-differences.md is out of date: run node scripts/gen-differences.mjs --write',
      );
      process.exit(1);
    }
    console.log('app differences table is up to date.');
  } else {
    process.stdout.write(markdown);
  }
}

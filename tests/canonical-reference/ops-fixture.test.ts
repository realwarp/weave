/**
 * Node side of the browser op-line check (task T2.8): builds the ops in
 * `tests/browser/fixtures/ops.json` and requires the same lines. The browser test builds the same
 * inputs in Chromium, so both runtimes must produce byte-identical op lines.
 *
 * Regenerate after an intended format change:  WEAVE_WRITE_FIXTURES=1 npx vitest run tests/canonical-reference
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { buildOp } from '@weave/core/protocol';

const fixture = fileURLToPath(new URL('../browser/fixtures/ops.json', import.meta.url));

const A = 'aaaaaaaaaaaaaaaaaaaaaaaaaa';
const B = 'bbbbbbbbbbbbbbbbbbbbbbbbbb';
const inputs: Array<Parameters<typeof buildOp>[0]> = [
  {
    replicaId: A,
    vector: {},
    maxLamport: 0,
    collection: 'notes',
    recordId: 'r1',
    kind: 'set',
    schemaVersion: 1,
    fields: { title: 'plain' },
  },
  {
    replicaId: B,
    vector: { [A]: 1 },
    maxLamport: 1,
    collection: 'notes',
    recordId: 'r1',
    kind: 'set',
    schemaVersion: 2,
    fields: {
      title: 'caf\u00e9 \u2028 \ud83d\ude00 \u20ac',
      n: 0.1,
      big: 9007199254740991,
      neg: -0,
      nested: { z: [true, null, { b: 1, a: 2 }] },
      '\ue000': 1,
      '\u{10000}': 2,
    },
  },
  {
    replicaId: A,
    vector: { [A]: 1, [B]: 1 },
    maxLamport: 2,
    collection: 'notes',
    recordId: 'r1',
    kind: 'delete',
    schemaVersion: 1,
    fields: {},
  },
];

it('op lines built in Node match the browser fixture', async () => {
  const built = [];
  for (const input of inputs) built.push({ input, line: (await buildOp(input)).line });
  if (process.env['WEAVE_WRITE_FIXTURES'] === '1' || !existsSync(fixture)) {
    writeFileSync(fixture, `${JSON.stringify(built, null, 2)}\n`);
  }
  expect(JSON.parse(readFileSync(fixture, 'utf8'))).toEqual(JSON.parse(JSON.stringify(built)));
});

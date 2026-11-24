/** App differences table (task T3.X1, R14a.3): generated from the models, never edited by hand. */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
// @ts-expect-error plain JavaScript module
import { generateDifferences } from '../../scripts/gen-differences.mjs';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const fixture = fileURLToPath(new URL('../../scripts/fixtures/differences', import.meta.url));

describe('app differences table', () => {
  it('docs/app-differences.md equals the generated table and every field maps to a demo step', () => {
    const { markdown, problems } = generateDifferences(repoRoot) as {
      markdown: string;
      problems: string[];
    };
    expect(problems).toEqual([]);
    const committed = readFileSync(`${repoRoot}docs/app-differences.md`, 'utf8').replace(
      /\r\n/g,
      '\n',
    );
    expect(committed).toBe(markdown);
    // The apps really differ: FIELDNOTE uses `max`, GHOSTLINE does not.
    expect(markdown).toMatch(
      /\| `max` \(highest value wins\) \| not used \| `observations.severity` \|/,
    );
  });

  it('fails on a model field without a demo step, or with a step the demo does not have', () => {
    const { problems } = generateDifferences(fixture) as { problems: string[] };
    expect(problems).toContain(
      'ghostline: @demo missing-step (field "title") is not a step in src/demo.ts',
    );
    expect(problems).toContain('ghostline: notes v1 field "body" has no @demo tag');
  });
});

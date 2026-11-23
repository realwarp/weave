import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
// @ts-expect-error plain JavaScript module
import { checkBoundaries } from '../../scripts/check-boundaries.mjs';
// @ts-expect-error plain JavaScript module
import { checkLicense } from '../../scripts/check-license.mjs';

const fixture = (name: string): string =>
  fileURLToPath(new URL(`../../scripts/fixtures/${name}`, import.meta.url));
const repoRoot = fileURLToPath(new URL('../../', import.meta.url));

describe('boundary checks (T0.5)', () => {
  it('fails on deliberately bad fixtures', () => {
    const violations: string[] = checkBoundaries(fixture('bad'));
    const text = violations.join('\n');
    expect(text).toContain('core must not import node:fs');
    expect(text).toContain('core must not import @weave/storage/memory');
    expect(text).toContain('Math.random');
    expect(text).toContain('relay may import only @weave/core/protocol');
    expect(text).toContain('relay must not import ../state/derive.js');
    expect(text).toContain('app imports outside itself');
    expect(text).toContain('app imports into packages/');
    expect(text).toContain('forbidden sync identifier "lamport"');
    expect(text).toContain('app imports an internal module: @weave/core/engine');
  });

  it('passes on good fixtures', () => {
    expect(checkBoundaries(fixture('good'))).toEqual([]);
  });

  it('passes on the real repository', () => {
    expect(checkBoundaries(repoRoot)).toEqual([]);
  });

  it('license check passes on the repository', () => {
    expect(checkLicense(repoRoot)).toEqual([]);
  });
});

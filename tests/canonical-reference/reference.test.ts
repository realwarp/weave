import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
// @ts-expect-error plain JavaScript module without type declarations
import { canonicalize } from './reference.mjs';

interface Vector {
  name: string;
  inputJson: string;
  canonical: string;
  sha256: string;
  supported: boolean;
}

const file = JSON.parse(
  readFileSync(new URL('../../packages/core/test/canonical/vectors.json', import.meta.url), 'utf8'),
) as {
  vectors: Vector[];
  setUnion: Array<{ name: string; inputJson: string; expectedJson: string }>;
};

describe('independent RFC 8785 reference reproduces the test vectors (T0.4)', () => {
  for (const v of file.vectors) {
    it(`canonical text: ${v.name}`, () => {
      expect(canonicalize(JSON.parse(v.inputJson))).toBe(v.canonical);
    });
    it(`sha256: ${v.name}`, () => {
      expect(createHash('sha256').update(v.canonical, 'utf8').digest('hex')).toBe(v.sha256);
    });
  }

  it('key order differs between UTF-16 and UTF-8 (the vector really distinguishes them)', () => {
    const keys = ['\ue000', '\ud800\udc00'];
    const utf16 = [...keys].sort();
    const utf8 = [...keys].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
    expect(utf16).not.toEqual(utf8);
    const v = file.vectors.find((x) => x.name === 'utf16-vs-utf8-property-order');
    expect(v?.canonical.startsWith('{"\ud800\udc00"')).toBe(true);
  });

  it('set-union expectations follow UTF-8 byte order of the canonical encoding', () => {
    for (const s of file.setUnion) {
      const input = JSON.parse(s.inputJson) as unknown[];
      const unique = new Map<string, unknown>();
      for (const item of input) unique.set(canonicalize(item), item);
      const sorted = [...unique.entries()]
        .sort((a, b) => Buffer.compare(Buffer.from(a[0], 'utf8'), Buffer.from(b[0], 'utf8')))
        .map((e) => e[1]);
      expect(JSON.stringify(sorted)).toBe(JSON.stringify(JSON.parse(s.expectedJson)));
    }
  });
});

/**
 * Canonical encoding in Chromium (R15.10): every vector gives the same bytes and the same SHA-256
 * as in Node. The vectors file is the one the Node tests load.
 */
import { describe, expect, it } from 'vitest';
import {
  assertSupported,
  encodeCanonical,
  toCanonical,
} from '../../packages/core/src/canonical/encode.js';
import { sha256Hex } from '../../packages/core/src/canonical/hash.js';
import { buildOp, verifyOpLine } from '../../packages/core/src/ops/op.js';
import file from '../../packages/core/test/canonical/vectors.json';
import expectedOps from './fixtures/ops.json';

const hex = (s: string) =>
  [...new TextEncoder().encode(s)].map((b) => b.toString(16).padStart(2, '0')).join('');

describe('canonical vectors in Chromium', () => {
  it('runs in a real browser', () => {
    expect(typeof window).toBe('object');
    expect(navigator.userAgent).toMatch(/Chrome/);
  });

  for (const v of file.vectors) {
    it(`encodes ${v.name} to the same bytes and hash as Node`, async () => {
      const value: unknown = JSON.parse(v.inputJson);
      const text = encodeCanonical(value);
      expect(hex(text)).toBe(hex(v.canonical));
      expect(await sha256Hex(text)).toBe(v.sha256);
      if (v.supported) expect(toCanonical(value)).toBe(v.canonical);
      else expect(() => assertSupported(value)).toThrow();
    });
  }

  for (const r of file.rejectedJson) {
    it(`rejects ${r.name}`, () => {
      expect(() => assertSupported(JSON.parse(r.inputJson))).toThrow();
    });
  }

  it('builds op lines byte-identical to Node, and verifies them', async () => {
    for (const e of expectedOps) {
      const { line } = await buildOp(e.input as Parameters<typeof buildOp>[0]);
      expect(line).toBe(e.line);
      await expect(verifyOpLine(e.line)).resolves.toBeTruthy();
    }
  });
});

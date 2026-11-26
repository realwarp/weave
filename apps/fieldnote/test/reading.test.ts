/**
 * FIELDNOTE numeric readings. A worker types a reading as text; a blank reading means "none" (the
 * field is optional), zero is a real reading, and anything that is not a plain finite number is
 * refused before an operation is written (it used to become NaN and fail inside WEAVE's encoder,
 * or, for "0x10", be stored silently as 16).
 */
import { describe, expect, it } from 'vitest';
import { createReplica } from '@weave/core';
import { memoryStorage } from '@weave/storage/memory';
import {
  addObservation,
  createInspection,
  editObservation,
  observationsOf,
  parseReading,
  type Session,
} from '../src/logic.js';
import { collectionsV2 } from '../src/model.js';
import { memoryPending } from '../src/pending.js';

describe('parseReading', () => {
  it('treats blank input as no reading', () => {
    for (const t of ['', '   ', '\t'])
      expect(parseReading(t)).toEqual({ ok: true, reading: undefined });
  });

  it('accepts plain decimal numbers, including zero and negatives', () => {
    const cases: Array<[string, number]> = [
      ['0', 0],
      ['0.0', 0],
      ['4.2', 4.2],
      [' 12 ', 12],
      ['-3.5', -3.5],
      ['+7', 7],
      ['.5', 0.5],
      ['5.', 5],
      ['1e3', 1000],
      ['2.5E-2', 0.025],
    ];
    for (const [text, reading] of cases) expect(parseReading(text)).toEqual({ ok: true, reading });
  });

  it('refuses malformed text instead of turning it into NaN or another number', () => {
    for (const t of [
      'abc',
      '12 kPa',
      '1.2.3',
      '--1',
      '0x10',
      '0b11',
      '1_000',
      'NaN',
      '.',
      '-',
      'e5',
    ])
      expect(parseReading(t)).toMatchObject({ ok: false });
  });

  it('explains a decimal comma', () => {
    expect(parseReading('1,5')).toEqual({
      ok: false,
      error: 'Use a dot for decimals, for example 1.5.',
    });
  });

  it('refuses non-finite numbers', () => {
    for (const t of ['Infinity', '-Infinity', '1e400'])
      expect(parseReading(t)).toMatchObject({ ok: false });
  });
});

describe('observation readings through the app logic', () => {
  async function session(): Promise<Session> {
    const replica = await createReplica({ storage: memoryStorage(), collections: collectionsV2 });
    return { replica, pending: memoryPending(), user: 'ana', version: 2 };
  }

  it('stores a blank reading as absent and zero as zero', async () => {
    const s = await session();
    const { recordId } = await createInspection(s, 'i', { title: 'Pump 3' });
    await addObservation(s, 'o1', recordId, { note: 'no gauge', severity: 1 });
    await addObservation(s, 'o2', recordId, { note: 'gauge at rest', severity: 1, reading: 0 });
    const byNote = new Map((await observationsOf(s, recordId)).map((o) => [o.note, o]));
    expect(byNote.get('no gauge')?.reading).toBeUndefined();
    expect(byNote.get('gauge at rest')?.reading).toBe(0);
  });

  it('refuses a non-finite reading before writing anything or storing an intent', async () => {
    const s = await session();
    const { recordId } = await createInspection(s, 'i', { title: 'Pump 3' });
    const before = JSON.stringify((await s.replica.status()).vector);
    for (const reading of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(() => addObservation(s, 'bad', recordId, { note: 'x', severity: 2, reading })).toThrow(
        'reading must be a finite number',
      );
    }
    expect(s.pending.get('observation:bad')).toBeUndefined();
    expect(JSON.stringify((await s.replica.status()).vector)).toBe(before);
    expect(await observationsOf(s, recordId)).toEqual([]);
  });

  it('refuses a non-finite reading on edit and keeps the stored value', async () => {
    const s = await session();
    const { recordId } = await createInspection(s, 'i', { title: 'Pump 3' });
    const { recordId: obsId } = await addObservation(s, 'o', recordId, {
      note: 'pressure',
      severity: 2,
      reading: 1.4,
    });
    expect(() => editObservation(s, obsId, { reading: Number.NaN })).toThrow(
      'reading must be a finite number',
    );
    expect((await observationsOf(s, recordId))[0]?.reading).toBe(1.4);
  });
});

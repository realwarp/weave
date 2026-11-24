/**
 * FIELDNOTE data model (design 13.2, R14). Field inspections with observations. Version 2 of
 * `inspections` replaces the free-text `location` with `site` and `zone`; old ops are upgraded on
 * read by the migration below and are never rewritten.
 */
import { defineCollection, f, type InferRecord } from '@weave/core';

export const STATUS = ['open', 'in_review', 'closed'] as const;

export const inspectionsV1 = defineCollection({
  name: 'inspections',
  version: 1,
  fields: {
    /** @demo v1-work */
    title: f.string({ required: true, resolver: 'last-writer-wins' }),
    /** @demo upgrade */
    location: f.string({ resolver: 'last-writer-wins' }),
    /** @demo v1-work */
    status: f.rank(STATUS, { required: true }),
    /** @demo v1-work */
    assignees: f.set(f.string()),
  },
});

/** Splits a v1 `location` at the first " / " into `site` and `zone` (`zone` is "" if absent). */
export function splitLocation(location: string): { site: string; zone: string } {
  const at = location.indexOf(' / ');
  return at < 0
    ? { site: location, zone: '' }
    : { site: location.slice(0, at), zone: location.slice(at + 3) };
}

export const inspectionsV2 = defineCollection({
  name: 'inspections',
  version: 2,
  fields: {
    /** @demo result */
    title: f.string({ required: true, resolver: 'last-writer-wins' }),
    /** @demo upgrade */
    site: f.string({ resolver: 'last-writer-wins' }),
    /** @demo result */
    zone: f.string({ resolver: 'last-writer-wins' }),
    /** @demo result */
    status: f.rank(STATUS, { required: true }),
    /** @demo result */
    assignees: f.set(f.string()),
  },
  migrations: {
    // Pure and total: depends only on the op's own fields.
    1: ({ fields }) => {
      const { location, ...rest } = fields;
      return typeof location === 'string' ? { ...rest, ...splitLocation(location) } : { ...rest };
    },
  },
});

export const observations = defineCollection({
  name: 'observations',
  version: 1,
  fields: {
    /** @demo v1-work */
    inspectionId: f.string({ required: true }),
    /** @demo replay */
    note: f.string({ resolver: 'last-writer-wins' }),
    /**
     * 1 (minor) to 5 (critical); concurrent values resolve to the higher one.
     * @demo result
     */
    severity: f.number({ required: true, resolver: 'max' }),
    /** @demo result */
    reading: f.number({ resolver: 'last-writer-wins' }),
  },
});

export const collectionsV1 = [inspectionsV1, observations];
export const collectionsV2 = [inspectionsV2, observations];

export type InspectionV1 = InferRecord<typeof inspectionsV1>;
export type InspectionV2 = InferRecord<typeof inspectionsV2>;
export type Observation = InferRecord<typeof observations>;

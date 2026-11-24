/**
 * GHOSTLINE data model (design 13.1, R13). Community coordination: announcements that are drafted
 * and published, and requests that people claim, tag and fulfil.
 *
 * Each field's `@demo` tag names the demo step that shows its merge rule; the app differences
 * table (`docs/app-differences.md`) is generated from these declarations.
 */
import { defineCollection, f, type InferRecord } from '@weave/core';

export const announcements = defineCollection({
  name: 'announcements',
  version: 1,
  fields: {
    /** @demo offline */
    title: f.string({ required: true, resolver: 'last-writer-wins' }),
    /** @demo concurrent */
    body: f.string({ resolver: 'last-writer-wins' }),
    /** @demo result */
    status: f.rank(['draft', 'published'], { required: true }),
    /** @demo offline */
    author: f.string({ required: true, resolver: 'last-writer-wins' }),
  },
});

/**
 * Version 2 (0.2.0, R13.7) adds the "me too" counter. Version 1 requests upgrade unchanged (they
 * have no counter yet, which reads as 0); a 0.1.0 app is told it needs an update instead of
 * rejecting the new field.
 */
export const requests = defineCollection({
  name: 'requests',
  version: 2,
  migrations: { 1: ({ fields }) => ({ ...fields }) },
  fields: {
    /** @demo offline */
    title: f.string({ required: true, resolver: 'last-writer-wins' }),
    /** @demo offline */
    details: f.string({ resolver: 'last-writer-wins' }),
    /** @demo result */
    tags: f.set(f.string()),
    /** @demo notices */
    claimedBy: f.string({ resolver: 'last-writer-wins' }),
    /** @demo replay */
    state: f.rank(['open', 'fulfilled'], { required: true }),
    /**
     * "Me too" taps: every device's taps are summed (counter resolver, R13.7).
     * @demo metoo
     */
    meToo: f.counter(),
  },
});

export const collections = [announcements, requests];

export type Announcement = InferRecord<typeof announcements>;
export type HelpRequest = InferRecord<typeof requests>;

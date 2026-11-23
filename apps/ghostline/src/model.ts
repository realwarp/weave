/**
 * GHOSTLINE data model (design 13.1, R13). Community coordination: announcements that are drafted
 * and published, and requests that people claim, tag and fulfil.
 */
import { defineCollection, f, type InferRecord } from '@weave/core';

export const announcements = defineCollection({
  name: 'announcements',
  version: 1,
  fields: {
    title: f.string({ required: true, resolver: 'last-writer-wins' }),
    body: f.string({ resolver: 'last-writer-wins' }),
    status: f.rank(['draft', 'published'], { required: true }),
    author: f.string({ required: true, resolver: 'last-writer-wins' }),
  },
});

export const requests = defineCollection({
  name: 'requests',
  version: 1,
  fields: {
    title: f.string({ required: true, resolver: 'last-writer-wins' }),
    details: f.string({ resolver: 'last-writer-wins' }),
    tags: f.set(f.string()),
    claimedBy: f.string({ resolver: 'last-writer-wins' }),
    state: f.rank(['open', 'fulfilled'], { required: true }),
  },
});

export const collections = [announcements, requests];

export type Announcement = InferRecord<typeof announcements>;
export type HelpRequest = InferRecord<typeof requests>;

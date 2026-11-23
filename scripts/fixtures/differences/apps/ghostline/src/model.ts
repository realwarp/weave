import { defineCollection, f } from '@weave/core';
export const notes = defineCollection({
  name: 'notes',
  version: 1,
  fields: {
    /** @demo missing-step */
    title: f.string({ required: true }),
    body: f.string(),
  },
});

/**
 * `@weave/core` public API (design 7.1). The engine entry points (`createReplica`,
 * `defineCollection`, `f`) are added by the engine tasks; this file exports only what exists.
 */
export type * from './contracts/index.js';
export { WeaveError, isWeaveError, ERROR_CODES } from './contracts/errors.js';
export { newMutationId, platformRandom, randomFloat } from './ops/random.js';

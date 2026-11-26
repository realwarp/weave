/**
 * `@weave/core` public API (design 7.1).
 */
export type * from './contracts/index.js';
export { WeaveError, isWeaveError, ERROR_CODES } from './contracts/errors.js';
export { createReplica } from './engine/replica.js';
export { defineCollection, f } from './schema/index.js';
export { defineResolver } from './resolvers/custom.js';
export { assertResolverDeterministic, type AssertResolverOptions } from './resolvers/assert.js';
export { newMutationId, platformRandom, randomFloat } from './ops/random.js';
export { systemClock, systemScheduler } from './ops/clock.js';

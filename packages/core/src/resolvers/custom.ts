/**
 * [ADV] Custom resolvers (R6.10, task T5.4). A custom resolver is attached to one field with
 * `f.custom(base, defineResolver(name, fn))`; there is no global registry, so two replicas agree
 * exactly when their collection definitions use the same code. The engine checks every result:
 * a resolver that throws or returns a value that is not D7-supported or fails the field's own type
 * check gives `RESOLVER_ERROR`.
 */
import { assertSupported } from '../canonical/encode.js';
import { WeaveError, isWeaveError } from '../contracts/errors.js';
import type { JsonValue } from '../contracts/json.js';
import type {
  CustomResolver,
  FrontierEntry,
  Resolver,
  ResolverContext,
} from '../contracts/resolver.js';

export const RESOLVER_NAME_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;

/**
 * Names a custom resolver (R6.10).
 * @param name A stable name, `[a-z][a-z0-9-]{0,63}`.
 * @param resolve A pure function of the multiset of frontier entries (R6.6).
 * @returns A frozen custom resolver to pass to `f.custom()`.
 * @throws VALIDATION_FAILED if the name or function is invalid.
 */
export function defineResolver<V = JsonValue>(
  name: string,
  resolve: Resolver<V>,
): CustomResolver<V> {
  if (typeof name !== 'string' || !RESOLVER_NAME_PATTERN.test(name)) {
    throw new WeaveError('VALIDATION_FAILED', `Invalid resolver name "${String(name)}"`);
  }
  if (typeof resolve !== 'function') {
    throw new WeaveError('VALIDATION_FAILED', `Resolver "${name}" must be a function`);
  }
  return Object.freeze({ name, resolve });
}

/**
 * Runs a custom resolver and checks its result. Never lets a non-JSON or ill-typed value into
 * derived state.
 */
export function runCustom(
  custom: CustomResolver,
  entries: readonly FrontierEntry[],
  context: ResolverContext,
  validate: (value: unknown) => boolean,
): JsonValue {
  let value: JsonValue;
  try {
    value = custom.resolve(entries, context);
  } catch (e) {
    if (isWeaveError(e) && e.code === 'RESOLVER_ERROR') throw e;
    throw new WeaveError('RESOLVER_ERROR', `Resolver "${custom.name}" threw`, {
      details: { resolver: custom.name },
      cause: e,
    });
  }
  try {
    assertSupported(value);
  } catch (e) {
    throw new WeaveError(
      'RESOLVER_ERROR',
      `Resolver "${custom.name}" returned an unsupported value`,
      {
        details: { resolver: custom.name },
        cause: e,
      },
    );
  }
  if (!validate(value)) {
    throw new WeaveError(
      'RESOLVER_ERROR',
      `Resolver "${custom.name}" returned a value of the wrong type`,
      { details: { resolver: custom.name, value } },
    );
  }
  return value;
}

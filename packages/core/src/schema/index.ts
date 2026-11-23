/**
 * Schema language, validation and migrations (R8.1 to R8.5, R6.4, R6.5, design 5.1, 5.3).
 */
import { assertSupported, toCanonical } from '../canonical/encode.js';
import { WeaveError } from '../contracts/errors.js';
import type { JsonValue } from '../contracts/json.js';
import type { ResolverName } from '../contracts/resolver.js';
import type { CollectionDefinition, FieldSpec, Migration } from '../contracts/schema.js';
import { COLLECTION_PATTERN } from '../ops/op.js';

type Req<O> = O extends { readonly required: true } ? true : false;
type Spec<T, O> = FieldSpec<T> & { readonly required: Req<O> };

interface BaseOptions {
  readonly required?: boolean;
}
interface OrderedOptions extends BaseOptions {
  readonly resolver?: 'last-writer-wins' | 'max' | 'min';
}

function spec<T>(
  kind: FieldSpec['kind'],
  required: boolean,
  resolver: ResolverName,
  validate: (v: unknown) => boolean,
  extra: Partial<Pick<FieldSpec, 'rankMap' | 'element'>> = {},
): FieldSpec<T> {
  return Object.freeze({ kind, required, resolver, validate, ...extra }) as FieldSpec<T>;
}

const isString = (v: unknown): v is string => typeof v === 'string';
const isNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/**
 * Field builders (design 5.1). The resolver defaults to last-writer-wins.
 * Each builder returns a field specification with the appropriate type and validator.
 */
export const f = {
  /**
   * Creates a string field specification.
   * @param options Configuration options including required status and resolver choice.
   * @returns A field specification for string values.
   */
  string<const O extends OrderedOptions = Record<never, never>>(options?: O): Spec<string, O> {
    return spec<string>(
      'string',
      options?.required === true,
      options?.resolver ?? 'last-writer-wins',
      isString,
    ) as Spec<string, O>;
  },
  /**
   * Creates a number field specification.
   * @param options Configuration options including required status and resolver choice.
   * @returns A field specification for numeric values.
   */
  number<const O extends OrderedOptions = Record<never, never>>(options?: O): Spec<number, O> {
    return spec<number>(
      'number',
      options?.required === true,
      options?.resolver ?? 'last-writer-wins',
      isNumber,
    ) as Spec<number, O>;
  },
  /**
   * Creates a boolean field specification.
   * @param options Configuration options including required status.
   * @returns A field specification for boolean values.
   */
  boolean<const O extends BaseOptions = Record<never, never>>(options?: O): Spec<boolean, O> {
    return spec<boolean>(
      'boolean',
      options?.required === true,
      'last-writer-wins',
      (v) => typeof v === 'boolean',
    ) as Spec<boolean, O>;
  },
  /**
   * Creates a JSON field specification that accepts any valid JSON value.
   * @param options Configuration options including required status.
   * @returns A field specification for JSON values.
   */
  json<const O extends BaseOptions = Record<never, never>>(options?: O): Spec<JsonValue, O> {
    return spec<JsonValue>(
      'json',
      options?.required === true,
      'last-writer-wins',
      () => true,
    ) as Spec<JsonValue, O>;
  },
  /**
   * Creates a set field specification whose values are arrays of element values.
   * Elements are merged by union using the `set-union` resolver.
   * @param element The field specification for set elements.
   * @param options Configuration options including required status.
   * @returns A field specification for arrays of element values.
   */
  set<T, const O extends BaseOptions = Record<never, never>>(
    element: FieldSpec<T>,
    options?: O,
  ): Spec<T[], O> {
    return spec<T[]>(
      'set',
      options?.required === true,
      'set-union',
      (v) => Array.isArray(v) && v.every((item) => element.validate(item)),
      { element: element as FieldSpec },
    ) as Spec<T[], O>;
  },
  /**
   * Creates a rank field specification that accepts only values from a predefined ordered list.
   * Concurrent values resolve to the highest rank in the list.
   * @param values An ordered list of distinct values.
   * @param options Configuration options including required status.
   * @returns A field specification for ranked values.
   */
  rank<const V extends string | number, const O extends BaseOptions = Record<never, never>>(
    values: readonly V[],
    options?: O,
  ): Spec<V, O> {
    if (values.length === 0)
      throw new WeaveError('VALIDATION_FAILED', 'A rank map needs at least one value');
    if (new Set(values).size !== values.length) {
      throw new WeaveError('VALIDATION_FAILED', 'Rank map values must be distinct');
    }
    const kinds = new Set(values.map((v) => typeof v));
    if (kinds.size !== 1)
      throw new WeaveError('VALIDATION_FAILED', 'Rank map values must have one primitive type');
    const allowed = [...values];
    return spec<V>(
      'rank',
      options?.required === true,
      'max-rank',
      (v) => (allowed as unknown[]).includes(v),
      {
        rankMap: Object.freeze(allowed),
      },
    ) as Spec<V, O>;
  },
} as const;

const validFieldName = (name: string): boolean => name.length > 0 && !name.includes('\u0000');

/**
 * Declares a collection with its fields, version, and migration path.
 * @param definition The collection definition including name, version, fields, and optional migrations.
 * @returns A frozen collection definition.
 * @throws VALIDATION_FAILED if the name, version, fields, or migration chain are invalid.
 */
export function defineCollection<const F extends Record<string, FieldSpec>>(definition: {
  readonly name: string;
  readonly version: number;
  readonly fields: F;
  readonly migrations?: Readonly<Record<number, Migration>>;
}): CollectionDefinition<F> {
  const { name, version, fields } = definition;
  const migrations = definition.migrations ?? {};
  if (!COLLECTION_PATTERN.test(name)) {
    throw new WeaveError('VALIDATION_FAILED', `Invalid collection name "${name}"`);
  }
  if (!Number.isSafeInteger(version) || version < 1) {
    throw new WeaveError(
      'VALIDATION_FAILED',
      `Collection "${name}": version must be a positive integer`,
    );
  }
  for (const field of Object.keys(fields)) {
    if (!validFieldName(field))
      throw new WeaveError('VALIDATION_FAILED', `Invalid field name "${field}"`);
  }
  for (let v = 1; v < version; v++) {
    if (typeof migrations[v] !== 'function') {
      throw new WeaveError(
        'VALIDATION_FAILED',
        `Collection "${name}": missing migration from version ${v} to ${v + 1}`,
      );
    }
  }
  return Object.freeze({ name, version, fields, migrations: Object.freeze({ ...migrations }) });
}

function fail(
  code: 'VALIDATION_FAILED' | 'MIGRATION_FAILED',
  message: string,
  details: Record<string, unknown>,
): never {
  throw new WeaveError(code, message, { details });
}

/**
 * Type checks the given fields against the current schema.
 * Unknown fields are rejected.
 * @param definition The collection definition to validate against.
 * @param fields The fields to validate.
 * @throws VALIDATION_FAILED if any field is unknown or has an invalid type.
 */
export function checkFieldTypes(
  definition: CollectionDefinition,
  fields: Readonly<Record<string, JsonValue>>,
): void {
  for (const [name, value] of Object.entries(fields)) {
    const field = definition.fields[name];
    if (field === undefined) {
      fail('VALIDATION_FAILED', `Unknown field "${name}" in collection "${definition.name}"`, {
        collection: definition.name,
        field: name,
      });
    }
    if (!field.validate(value)) {
      fail(
        'VALIDATION_FAILED',
        `Invalid value for field "${name}" in collection "${definition.name}"`,
        {
          collection: definition.name,
          field: name,
        },
      );
    }
  }
}

/**
 * Validation of a local write before anything is stored (R8.2).
 * @param definition The collection definition to validate against.
 * @param kind `'create'` or `'update'`.
 * @param fields The fields to validate.
 * @returns The validated and normalized record object.
 * @throws VALIDATION_FAILED if validation fails.
 */
export function validateLocalWrite(
  definition: CollectionDefinition,
  kind: 'create' | 'update',
  fields: unknown,
): Readonly<Record<string, JsonValue>> {
  if (typeof fields !== 'object' || fields === null || Array.isArray(fields)) {
    fail('VALIDATION_FAILED', 'A record value must be an object', { collection: definition.name });
  }
  assertSupported(fields);
  const record = fields as Record<string, JsonValue>;
  checkFieldTypes(definition, record);
  if (kind === 'create') {
    for (const [name, field] of Object.entries(definition.fields)) {
      if (field.required && !(name in record)) {
        fail('VALIDATION_FAILED', `Missing required field "${name}"`, {
          collection: definition.name,
          field: name,
        });
      }
    }
  } else if (Object.keys(record).length === 0) {
    fail('VALIDATION_FAILED', 'An update must change at least one field', {
      collection: definition.name,
    });
  }
  return record;
}

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null) {
    for (const v of Object.values(value)) deepFreeze(v);
    Object.freeze(value);
  }
  return value;
}

/**
 * Upgrades the fields of one op from `fromVersion` to the collection's current version (R8.3).
 * Each migration receives a deep-frozen copy and its output is checked against the D7 value rules.
 * @param definition The collection definition with migrations.
 * @param input The fields and metadata to migrate.
 * @returns The migrated fields.
 * @throws MIGRATION_FAILED if a migration throws or returns an unsupported value.
 */
export function migrateFields(
  definition: CollectionDefinition,
  input: {
    readonly fields: Readonly<Record<string, JsonValue>>;
    readonly recordId: string;
    readonly fromVersion: number;
  },
): Readonly<Record<string, JsonValue>> {
  let fields = input.fields;
  for (let v = input.fromVersion; v < definition.version; v++) {
    const migration = definition.migrations[v];
    if (migration === undefined) {
      fail('MIGRATION_FAILED', `No migration from version ${v}`, {
        collection: definition.name,
        fromVersion: v,
      });
    }
    const frozen = deepFreeze(JSON.parse(toCanonical(fields)) as Record<string, JsonValue>);
    let next: unknown;
    try {
      next = migration({
        fields: frozen,
        collection: definition.name,
        recordId: input.recordId,
        fromVersion: v,
      });
    } catch (e) {
      throw new WeaveError(
        'MIGRATION_FAILED',
        `Migration from version ${v} of "${definition.name}" threw`,
        {
          cause: e,
          details: { collection: definition.name, fromVersion: v, recordId: input.recordId },
        },
      );
    }
    if (typeof next !== 'object' || next === null || Array.isArray(next)) {
      fail('MIGRATION_FAILED', `Migration from version ${v} did not return an object`, {
        collection: definition.name,
      });
    }
    try {
      assertSupported(next);
    } catch (e) {
      throw new WeaveError(
        'MIGRATION_FAILED',
        `Migration from version ${v} returned an unsupported value`,
        {
          cause: e,
          details: { collection: definition.name, fromVersion: v },
        },
      );
    }
    fields = next as Record<string, JsonValue>;
  }
  return fields;
}

/**
 * Migrates the fields of an op and checks the types of the result (design 7.3 Phase A2).
 * @param definition The collection definition with migrations.
 * @param input The fields and metadata to migrate and validate.
 * @returns The migrated fields that pass type validation.
 * @throws MIGRATION_FAILED if migration or type validation fails.
 */
export function migrateAndCheck(
  definition: CollectionDefinition,
  input: {
    readonly fields: Readonly<Record<string, JsonValue>>;
    readonly recordId: string;
    readonly fromVersion: number;
  },
): Readonly<Record<string, JsonValue>> {
  const migrated = migrateFields(definition, input);
  try {
    checkFieldTypes(definition, migrated);
  } catch (e) {
    if (input.fromVersion < definition.version) {
      throw new WeaveError(
        'MIGRATION_FAILED',
        'A migrated value does not match the current schema',
        {
          cause: e,
          details: { collection: definition.name, fromVersion: input.fromVersion },
        },
      );
    }
    throw e;
  }
  return migrated;
}

/** What this set of collections can read: name to current version (R4.10). */
export function supportOf(definitions: readonly CollectionDefinition[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const d of definitions) out[d.name] = d.version;
  return out;
}

export const MUTATION_ID_PATTERN = /^[A-Za-z0-9_.:-]{1,128}$/;

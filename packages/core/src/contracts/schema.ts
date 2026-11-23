import type { JsonValue } from './json.js';
import type { ResolverName } from './resolver.js';

/** Field kinds of the schema language (design 5.1). */
export type FieldKind = 'string' | 'number' | 'boolean' | 'json' | 'set' | 'rank';

/**
 * Description of one field. `T` is a phantom type used only for inference of record types.
 * Built with the `f.*` builders (task T1.A4).
 */
export interface FieldSpec<out T = unknown> {
  /** The data type of this field. */
  readonly kind: FieldKind;
  /** Whether this field is required on record creation. */
  readonly required: boolean;
  /** The resolver name used to resolve conflicts for this field. */
  readonly resolver: ResolverName;
  /** `rank` fields: ordered list of distinct allowed values (R6.5). */
  readonly rankMap?: readonly (string | number)[];
  /** `set` fields: the element spec. */
  readonly element?: FieldSpec;
  /** Runtime type check of one value of this field (D7 support is checked separately). */
  validate(value: unknown): boolean;
  /** Phantom marker; never set at runtime. */
  readonly __type?: T;
}

/**
 * Input passed to a migration function during schema upgrade (R8.3).
 */
export interface MigrationInput {
  /** Deep-frozen copy of the op's fields at `fromVersion`. */
  readonly fields: Readonly<Record<string, JsonValue>>;
  /** The collection name of the record being migrated. */
  readonly collection: string;
  /** The record ID being migrated. */
  readonly recordId: string;
  /** The schema version from which we are migrating. */
  readonly fromVersion: number;
}

/**
 * Migration from version `n` to `n + 1`. Must be a deterministic, total function of its input
 * alone (R8.5): no clock, randomness, I/O, global state, other records or ops.
 */
export type Migration = (input: MigrationInput) => Record<string, JsonValue>;

/**
 * A collection definition specifies the structure of a collection, its fields, and migration path.
 */
export interface CollectionDefinition<
  F extends Record<string, FieldSpec> = Record<string, FieldSpec>,
> {
  /** Matches `[A-Za-z][A-Za-z0-9_]{0,63}`. */
  readonly name: string;
  /** Current schema version, at least 1. */
  readonly version: number;
  /** The fields of this collection. */
  readonly fields: F;
  /** Keyed by source version: `migrations[1]` upgrades version 1 to 2. */
  readonly migrations: Readonly<Record<number, Migration>>;
}

type FieldValue<S> = S extends FieldSpec<infer T> ? T : never;
type RequiredKeys<F extends Record<string, FieldSpec>> = {
  [K in keyof F]: F[K]['required'] extends true ? K : never;
}[keyof F];
type OptionalKeys<F extends Record<string, FieldSpec>> = Exclude<keyof F, RequiredKeys<F>>;

/** The record type inferred from a collection definition (R11.1). */
export type InferFields<F extends Record<string, FieldSpec>> = {
  [K in RequiredKeys<F>]: FieldValue<F[K]>;
} & {
  [K in OptionalKeys<F>]?: FieldValue<F[K]>;
};

/** The record type of a collection definition: required fields required, others optional. */
export type InferRecord<D> =
  D extends CollectionDefinition<infer F>
    ? { [K in keyof InferFields<F>]: InferFields<F>[K] }
    : never;

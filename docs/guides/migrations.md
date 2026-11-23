# Migrations

Migrations evolve collections across versions while preserving existing data.

## The migration contract

Requirements from `requirements.md` R8.3 to R8.5:

1. **Deterministic:** same input → same output, every time
2. **Total:** must handle every possible input (no undefined behavior)
3. **Input-only:** depends only on the input fields, no external state
4. **Frozen input:** the input object is never mutated; return a new object
5. **Prohibited sources:** no randomness, no wall clock, no I/O

A migration is a function:

```ts
type Migration = (input: Record<string, JsonValue>) => Record<string, JsonValue>;
```

## Upgrade-on-read

Migrations run when an op is applied during sync or a record is read. The replica checks the collection's schema version and applies any necessary migrations transparently.

## v1 to v2 example: FIELDNOTE location split

Suppose a fieldnote collection initially stored location as a single string:

```ts
// v1
const fieldnotes = defineCollection({
  name: 'fieldnotes',
  version: 1,
  fields: {
    location: f.string({ required: true }),
    // ...
  },
});
```

In v2, locations are split into latitude and longitude:

```ts
// v2
const fieldnotes = defineCollection({
  name: 'fieldnotes',
  version: 2,
  fields: {
    location: f.string({ required: true }), // kept for compatibility
    latitude: f.number({ required: true }),
    longitude: f.number({ required: true }),
    // ...
  },
  migrations: {
    1: (fields) => {
      // Parse "lat,lon" string into components
      const [latStr, lonStr] = (fields.location as string).split(',');
      const lat = parseFloat(latStr);
      const lon = parseFloat(lonStr);
      return {
        ...fields,
        latitude: lat,
        longitude: lon,
      };
    },
  },
});
```

## Migration tests

Migrations are pure functions and can be tested with property-based tests:

- **Repeatability:** same input yields same output across multiple runs
- **Chain:** v1→v2 followed by v2→v3 equals v1→v3
- **Cross-replica:** different replicas with the same input produce the same output
- **Frozen-input mutation:** input is never modified

Tests are evidence, not proof, of purity. The contract is enforced by design (no access to randomness or time) and by ESLint (restricted globals).

## The migration chain

- Each collection defines `migrations: { [fromVersion]: Migration }`
- On open, the replica checks `meta/schema` and applies migrations for any versions newer than the stored version
- Stored ops are never modified; only the derived state (`rec/`) is updated
- The migration chain is stored in the collection definition; the replica verifies it matches at open time
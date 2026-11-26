# Migrations

A collection's `version` rises when its fields change. Each step from version `n` to `n + 1` has a
migration. Stored ops are never rewritten: an old op is upgraded each time it is read.

## The contract

```ts
type Migration = (input: {
  fields: Readonly<Record<string, JsonValue>>; // deep-frozen fields at fromVersion
  collection: string;
  recordId: string;
  fromVersion: number;
}) => Record<string, JsonValue>;
```

A migration must be deterministic and total, and depend only on its input. It must not read the
clock, use randomness, do I/O, read other records or change its input. Every replica runs it on
the same ops, so any impurity would make replicas disagree.

## Example

```ts
const sites = defineCollection({
  name: 'sites',
  version: 2,
  fields: {
    name: f.string({ required: true }),
    lat: f.number(),
    lon: f.number(),
  },
  migrations: {
    // v1 stored "lat,lon" in one string field `location`.
    1: ({ fields }) => {
      const { location, ...rest } = fields;
      if (typeof location !== 'string') return { ...rest };
      const [lat, lon] = location.split(',').map(Number);
      return Number.isFinite(lat) && Number.isFinite(lon) ? { ...rest, lat: lat!, lon: lon! } : { ...rest };
    },
  },
});
```

## Mixed versions during sync

A replica reports the schema versions it can read. A sender delivers each origin's ops in order and
stops at the first op the receiver cannot read, so the receiver never holds a gap. The sync then
returns `partial` with code `PEER_SCHEMA_OLDER` and lists the blocked origins. After the receiver
upgrades, the next sync delivers the rest.

### Holding newer-schema ops (0.2.0, opt-in)

With `createReplica({ holdNewerSchema: true })`, a replica accepts ops it cannot read yet (a newer
`schemaVersion`, or a collection its code does not define) instead of stopping at them. It stores
and forwards them, but they stay out of derived state. `status().held` reports how many are held
and which schema version each collection needs. After the app is upgraded, the held ops are
validated against the new schema when the replica opens and then enter state; an op that fails
stays stored, never enters state, and is counted as invalid.

While a record has held ops, a local write to it fails with `SCHEMA_TOO_NEW`. Without the option,
the prefix rule above applies unchanged. Details: ADR-0015.

Writing with an older schema while peers use a newer one (mixed-version writing) is not
implemented.

## Testing a migration

Check that it gives the same output on repeated calls, that it does not change a frozen input, and
that the chain `1 -> 2 -> 3` matches applying each step in order.

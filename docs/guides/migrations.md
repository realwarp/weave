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

Writing with an older schema while peers use a newer one, and holding newer-schema ops for later,
are [ADV] features and not implemented.

## Testing a migration

Check that it gives the same output on repeated calls, that it does not change a frozen input, and
that the chain `1 -> 2 -> 3` matches applying each step in order.

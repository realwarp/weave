# Custom resolvers

Resolvers merge concurrent edits to a field by deterministically selecting one value from the field's frontier.

## What resolvers are

A resolver is a pure function that takes a field's frontier (the set of ops that set that field and are not causally followed by any other op setting it) and returns a single value.

```ts
interface FrontierEntry<V = JsonValue> {
  opId: OpId;
  lamport: number;
  replicaId: string;
  seq: number;
  value: V;
}

type Resolver<V = JsonValue> = (
  entries: readonly FrontierEntry<V>[],
  ctx: { rankMap?: readonly V[] }
) => V;
```

## Purity contract

- **Deterministic:** same frontier → same value, regardless of array order
- **Idempotent:** applying it twice yields the same result
- **Stateless:** no external dependencies, no randomness

Built-in resolvers ignore entry position entirely.

## Built-in resolvers

| Resolver | Rule |
|---|---|
| `last-writer-wins` | greatest `(lamport, replicaId, seq)` by D4 order |
| `max` | numeric/string comparison for numbers/strings |
| `min` | numeric/string comparison for numbers/strings |
| `set-union` | union of arrays, dedupe by canonical encoding, sort by UTF-8 encoding |
| `max-rank` | highest index in `rankMap` (schema guarantees distinct values) |

Custom resolvers are **[ADV]** and not implemented in the MVP. The registry accepts them but `defineCollection` only enables built-in names in the MVP.

## How built-ins are declared per field

```ts
const requests = defineCollection({
  name: 'requests',
  version: 1,
  fields: {
    title: f.string({ resolver: 'last-writer-wins' }),
    tags: f.set(f.string()),
    state: f.rank(['open', 'fulfilled'], { resolver: 'max-rank' }),
  },
});
```

Each field's builder accepts a `resolver` option that defaults to `last-writer-wins` for primitive types and the appropriate built-in for `set` and `rank`.
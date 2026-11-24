# Resolvers

A resolver decides the value of a field when concurrent ops set it. Its input is the field's
frontier: the ops that set the field and that no later op on the field causally follows.

```ts
interface FrontierEntry<V> {
  opId: { replicaId: string; seq: number };
  lamport: number;
  replicaId: string;
  seq: number;
  value: V;
}

type Resolver<V> = (entries: readonly FrontierEntry<V>[], context: { rankMap?: readonly V[] }) => V;
```

A resolver must be a pure function of the entries as a set. It must not depend on their array
order, the wall clock, randomness or any outside state. Every replica then picks the same value.

## Built-in resolvers

| Resolver           | Rule                                                                 | Declared by                       |
| ------------------ | -------------------------------------------------------------------- | --------------------------------- |
| `last-writer-wins` | the entry with the greatest `(lamport, replicaId, seq)`              | default for `string`, `number`, `boolean`, `json` |
| `max`, `min`       | the greatest or smallest value                                        | `f.number({ resolver: 'max' })`, `f.string({ resolver: 'min' })` |
| `set-union`        | the union of all arrays, without duplicates, sorted                   | `f.set(element)`                  |
| `max-rank`         | the value latest in the field's rank list                             | `f.rank(['open', 'done'])`        |

```ts
const requests = defineCollection({
  name: 'requests',
  version: 1,
  fields: {
    title: f.string({ required: true }),
    priority: f.number({ resolver: 'max' }),
    tags: f.set(f.string()),
    state: f.rank(['open', 'claimed', 'fulfilled']),
  },
});
```

A resolved conflict stays visible: `replica.conflicts.current()` lists open conflicts with their
frontier values, and `replica.conflicts.history()` keeps superseded ones.

## Custom resolvers

Not implemented. Custom resolvers and the `counter` resolver are [ADV] features (task T5.4).

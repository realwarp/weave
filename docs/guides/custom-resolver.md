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

## Counter fields (0.2.0)

`f.counter()` is a field whose value is the sum of every replica's changes, so concurrent
increments all count (a last-writer-wins number would lose one of them).

```ts
const posts = defineCollection({
  name: 'posts',
  version: 1,
  fields: { title: f.string({ required: true }), likes: f.counter() },
});

const { recordId } = await replica
  .collection(posts)
  .create({ title: 'Hello', likes: 0 }, { mutationId: replica.newMutationId() });
await replica.collection(posts).update(recordId, { likes: 1 }, { mutationId: replica.newMutationId() });
```

- A write gives a **delta**, not a total: `1` adds one, `-1` takes one away. `create` starts from
  zero plus the delta. Reads return the total as a number.
- A delta must be a safe integer, and the running totals must stay safe integers; otherwise the
  write fails with `VALIDATION_FAILED`. Totals are summed exactly.
- Each op stores the per-replica totals it has seen, so the count survives compaction. A faulty
  writer that sends smaller totals can lower the count; this is the same trust level as any other
  field write.

## Custom resolvers (0.2.0)

`f.custom(base, defineResolver(name, fn))` gives one field its own resolver. The base field keeps
its type check and `required` flag; only the merge of concurrent values changes.

```ts
import { assertResolverDeterministic, defineCollection, defineResolver, f } from '@weave/core';

// Concurrent values: keep the shortest, ties broken by the value itself.
const shortest = defineResolver<string>('shortest', (entries) =>
  entries
    .map((e) => e.value)
    .sort((a, b) => a.length - b.length || (a < b ? -1 : a > b ? 1 : 0))[0]!,
);

const labels = defineCollection({
  name: 'labels',
  version: 1,
  fields: { text: f.custom(f.string({ required: true }), shortest) },
});
```

- The function receives the frontier entries (see above), not bare values, and must return the
  field's value. Build the result from `entry.value`.
- The name must match `[a-z][a-z0-9-]{0,63}`. There is no global registry: replicas agree only when
  their collection definitions use the same resolver code, as with migrations.
- Every result is checked. A resolver that throws, returns a value WEAVE cannot encode, or returns
  a value that fails the base field's type check gives `RESOLVER_ERROR`, and nothing is stored.
- `f.custom` cannot wrap `f.counter()` (`VALIDATION_FAILED`).

Test every custom resolver with `assertResolverDeterministic(resolver, samples, options?)`. It calls
the resolver with every order of each sample (seeded orders above 6 entries, 200 by default), on
frozen copies, and fails with `RESOLVER_ERROR` if any order gives a different result or the
resolver changes its input. Passing it is evidence, not proof, that the resolver is pure.

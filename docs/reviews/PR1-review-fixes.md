# PR #1 Review: Conflict Frontier Fixes

## Scope

Review of fixes for two P2 findings raised by automated Codex review on https://github.com/realwarp/weave/pull/1 at commit dfefadb:

1. **apps/fieldnote/src/logic.ts**: `conflictHistory` used raw `collection.history()` to derive competing values, dropping migrated field names. A v1 `location` op conflicting with a v2 `site`/`zone` op was missing from the conflict view.
2. **apps/ghostline/src/logic.ts**: `notices` attributed claim attribution to every op of the user on the record instead of only the conflict frontier. A user whose earlier claim was causally superseded got `claim-lost` for a later conflict between other people.

Commit 01ae650 fixes both issues and adds regression tests. Boundary check (`scripts/check-boundaries.mjs`) was amended to allow apps to READ the public `ConflictRecord.frontier` field (property access only), while still forbidding declaring/importing the name.

## Commands, Exit Codes, and Key Output

```powershell
# Build
cd (local scratch directory)\1d579823\weave-release
npm run build
# Exit code: 0

# Lint
npm run lint
# Exit code: 0

# Typecheck tests
npm run typecheck:tests
# Exit code: 0

# Run tests
npm test
# Exit code: 0
# Test Files 45 passed (45)
# Tests 517 passed (517)

# Boundary checks
npm run check:boundaries
# Output: Boundary check passed.
# Exit code: 0

# Verify differences
node scripts/gen-differences.mjs --check
# Exit code: 0

# Demos
npm run demo:ghostline
# Exit code: 0

npm run demo:fieldnote
# Exit code: 0
```

## Bug Confirmation: Finding #1 (fieldnote conflict history)

### Original bug at dfefadb:

```typescript
// apps/fieldnote/src/logic.ts (buggy)
export async function conflictHistory(s: Session): Promise<ConflictRow[]> {
  // ...
  for (const c of await s.replica.conflicts.history()) {
    const col = c.collection === 'observations' ? obs(s) : insp(s);
    const ops = await col.history(c.recordId);  // <-- Raw ops as written
    const key = (o: { replicaId: string; seq: number }) => `${o.replicaId}:${o.seq}`;
    const touching = ops.filter((h) =>
      c.kind === 'delete' ? true : c.field !== undefined && c.field in h.fields,
    );
    const ids = new Set(touching.map((h) => key(h.opId)));
    const competing = touching.filter((h) => h.concurrentWith.some((o) => ids.has(key(o))));
    rows.push({
      // ...
      values: competing.map((h) =>
        h.kind === 'delete'
          ? 'delete'
          : show(c.field === undefined ? undefined : h.fields[c.field]),  // <-- Uses raw field name
      ),
      // ...
    });
  }
  return rows;
}
```

**Issue**: `collection.history()` returns ops as originally written (v1 ops contain `location`, not `site`/`zone`). When a v1 `location` edit conflicts with a v2 `site` edit, only the v2 value appears because `c.field === 'site'` but the v1 op's `h.fields['site']` is undefined.

### Fix in commit 01ae650:

```typescript
// apps/fieldnote/src/logic.ts (fixed)
export async function conflictHistory(s: Session): Promise<ConflictRow[]> {
  // ...
  for (const c of await s.replica.conflicts.history()) {
    let values: string[];
    if (c.kind === 'field') {
      // Conflict frontier entries carry migrated values (resolved, post-migration).
      values = c.frontier.map((e) => show(e.value));  // <-- Uses frontier, already migrated
    } else {
      // Delete conflicts: derive kind from raw history.
      const col = c.collection === 'observations' ? obs(s) : insp(s);
      const kinds = new Map(
        (await col.history(c.recordId)).map((h) => [`${h.opId.replicaId}:${h.opId.seq}`, h.kind]),
      );
      values = c.frontier.map((e) =>
        kinds.get(`${e.opId.replicaId}:${e.opId.seq}`) === 'delete' ? 'delete' : 'edit',
      );
    }
    rows.push({
      // ...
      values,
      // ...
    });
  }
  return rows;
}
```

### Test confirmation:

```bash
cd (local scratch directory)\1d579823\pr1-old  # buggy worktree
npx vitest run apps/fieldnote/test/logic-migrated-conflict.test.ts
# FAIL: conflict history across schema versions > a v1 location edit concurrent with a v2 site edit lists both competing values
# Expected: values = ['North', 'South'] after migration
# Actual (buggy): v1 edit's value not shown (location not site)
```

### Evidence:

- `test/logic-migrated-conflict.test.ts` line 33-49: v1 edit writes `location`, v2 edit writes `site`, both concurrent. After migration and sync, `conflictHistory` should show both competing values for field `site`.
- `packages/core/src/state/history.ts` (replayConflicts): The conflict log stores frontier entries with `value` (line 65: `value: e.value as JsonValue`), which is the migrated/resolved value from `derive.ts`.
- `packages/core/src/state/derive.ts` (migratedSetOps): Fields are migrated when op schemaVersion differs from definition version (lines 20-30).

**Finding #1 confirmed: REAL** — v1 location ops conflicting with v2 site/zone ops were dropped from conflict history view.

## Bug Confirmation: Finding #2 (ghostline claim attribution)

### Original bug at dfefadb:

```typescript
// apps/ghostline/src/logic.ts (buggy)
export async function notices(s: Session): Promise<Notice[]> {
  // ...
  for (const c of await s.replica.conflicts.history()) {
    const col = c.collection === 'requests' ? req(s) : ann(s);
    const mine = (await col.history(c.recordId)).filter((h) => h.opId.replicaId === s.replica.id);
    // ...
    if (c.kind === 'field' && c.field === 'claimedBy') {
      const iClaimed = mine.some((h) => h.fields['claimedBy'] === s.user);  // <-- Every op
      // ...
    }
  }
  return out;
}
```

**Issue**: `mine` collects **all** of the user's ops on the record, including ones causally superseded before the conflict. If Ana claimed at t1, Ben and Cho claimed concurrently at t2>t1, Ana's earlier claim op is still in `mine`, so she incorrectly gets `claim-lost` even though her claim was causally superseded before the conflict occurred.

### Fix in commit 01ae650:

```typescript
// apps/ghostline/src/logic.ts (fixed)
export async function notices(s: Session): Promise<Notice[]> {
  const open = new Set((await s.replica.conflicts.current()).map((c) => c.conflictId));
  const out: Notice[] = [];
  for (const c of await s.replica.conflicts.history()) {
    const col = c.collection === 'requests' ? req(s) : ann(s);
    // Only this device's ops IN the conflict frontier count: an earlier op that was causally
    // superseded before the conflict happened is not part of it.
    const inFrontier = new Set(
      c.frontier
        .filter((e) => e.opId.replicaId === s.replica.id)
        .map((e) => `${e.opId.replicaId}:${e.opId.seq}`),
    );
    const mine = (await col.history(c.recordId)).filter((h) =>
      inFrontier.has(`${h.opId.replicaId}:${h.opId.seq}`),
    );
    // ...
    if (c.kind === 'field' && c.field === 'claimedBy') {
      const iClaimed = c.frontier.some(
        (e) => e.opId.replicaId === s.replica.id && e.value === s.user,
      );
      const winner = typeof c.resolved === 'string' ? c.resolved : 'someone';
      out.push(
        iClaimed && c.resolved !== s.user
          ? {
              ...base,
              kind: 'claim-lost',
              message: `Someone else was chosen: ${winner} has this request.`,
            }
          : {
              ...base,
              kind: 'claim-conflict',
              message: `Several people claimed this request; ${winner} has it.`,
            },
      );
    }
    // ...
  }
  return out;
}
```

### Test confirmation:

```bash
cd (local scratch directory)\1d579823\pr1-old  # buggy worktree
npx vitest run apps/ghostline/test/logic-claim-frontier.test.ts
# FAIL: notices follow the conflict frontier > an earlier, causally superseded claim is not part of a later conflict
# Expected: Ana has no notice (her claim was superseded before the conflict)
# Actual (buggy): Ana gets 'claim-lost' because her earlier op is in history
```

### Evidence:

- `test/logic-claim-frontier.test.ts` lines 20-44: Ana claims first, then Ben and Cho claim concurrently. Ana's earlier claim was causally superseded; she should get `claim-conflict` (she's one of the concurrent claimants in the frontier) or nothing, but **not** `claim-lost`.
- `packages/core/src/state/derive.ts` (frontierOf): The frontier is the set of ops not causally followed by another op setting the same field (lines 43-45).
- `packages/core/src/state/derive.ts` (resolveWrites, toEntries): The frontier entries (`toEntries`) are what the ConflictRecord stores in `c.frontier`, which is used by the fixed `notices` function.

**Finding #2 confirmed: REAL** — claim attribution counted causally superseded ops instead of only frontier ops.

## Fix Assessment

### Fix correctness

1. **Conflict history (fieldnote)**: The fix uses `c.frontier` directly, which contains values after migration (as resolved by `derive.ts`). This correctly shows both `North` and `South` when a v1 `location` edit conflicts with a v2 `site` edit. The test verifies raw history remains unchanged.

2. **Notices (ghostline)**: The fix uses the conflict frontier to determine which ops are part of the current conflict. The frontier is derived from causality, so earlier, superseded ops are excluded. Both tests pass:
   - Earlier, superseded claim not included in later conflict.
   - Edit before delete that was seen by author correctly classified.

### Edge cases covered

- **Three-way concurrent claims**: Test includes Ben+Cho concurrent; Ana's earlier claim excluded.
- **Delete conflicts**: Test confirms edit-before-delete correctly shows `edit-not-applied`.
- **Superseded conflicts**: Test covers case where a prior claim is causally before the conflict frontier.
- **Raw history semantics**: `inspectionHistory` in fieldnote still returns ops as written (not migrated), unchanged per design.

### Boundary check (R14a.1)

`scripts/check-boundaries.mjs` now allows `x.frontier` property access (public field read) while still forbidding declaring/importing `frontier`. The fixture tests confirm:
- `apps/demo/src/frontier.ts` (declaring `function frontier(...)`) → violation.
- `apps/demo/src/conflict-view.ts` (reading `c.frontier`) → no violation.

This does not weaken R14a.1: only the public field read is permitted; the forbidden identifiers (`lamport`, `context`, `canonical`, `frontier`, etc.) remain blocked for declaration and internal use.

## Findings Table

| Findings at dfefadb | Severity | File:Line | Status |
|---------------------|----------|-----------|--------|
| V1 `location` op conflicting with v2 `site`/`zone` op dropped from conflictHistory | P2 | apps/fieldnote/src/logic.ts ~183 | REAL — fixed by using `c.frontier` with migrated values |
| Claim attribution uses every op instead of only frontier | P2 | apps/ghostline/src/logic.ts ~124 | REAL — fixed by using `c.frontier` filter |

## Final Verification

| Check | Command | Exit Code |
|-------|---------|-----------|
| Build | `npm run build` | 0 |
| Lint | `npm run lint` | 0 |
| Typecheck tests | `npm run typecheck:tests` | 0 |
| Tests | `npm test` (517 tests) | 0 |
| Boundary checks | `npm run check:boundaries` | 0 |
| Differences | `node scripts/gen-differences.mjs --check` | 0 |
| Ghostline demo | `npm run demo:ghostline` | 0 |
| Fieldnote demo | `npm run demo:fieldnote` | 0 |
| Regression test (fieldnote) | `npx vitest run apps/fieldnote/test/logic-migrated-conflict.test.ts` (buggy worktree) | FAIL (1) |
| Regression test (ghostline) | `npx vitest run apps/ghostline/test/logic-claim-frontier.test.ts` (buggy worktree) | FAIL (1) |

Verdict: PASS

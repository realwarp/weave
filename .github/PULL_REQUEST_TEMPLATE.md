## What and why

<!-- One purpose per pull request. What changes, and why? Link an issue if there is one. -->

## How it was tested

<!-- Which tests you added or ran. A bug fix should include a test that fails without it. -->

## Checklist

- [ ] `npm run lint`, `npm run format:check`, `npm run build`, `npm run typecheck:tests` and `npm test` pass
- [ ] `npm run check:boundaries` and `node scripts/gen-differences.mjs --check` pass
- [ ] Tests added or updated for behaviour changes
- [ ] Documentation and `CHANGELOG.md` (`[Unreleased]`) updated for user-visible changes
- [ ] No new runtime dependency, and no guarantee (idempotency, determinism, convergence, integrity, crash recovery) weakened

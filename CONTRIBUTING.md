# Contributing to WEAVE

Thank you for your interest. WEAVE is a small, early-stage project; bug reports, questions and
focused pull requests are all welcome.

## Set up

You need Node.js 22 or later (pinned in `.nvmrc`), npm and Git.

```sh
git clone https://github.com/realwarp/weave.git
cd weave
npm ci
npm run build
npm test
npx playwright install chromium   # for the browser tests
```

[docs/guides/getting-started.md](docs/guides/getting-started.md) explains how to run the apps,
demos and every test suite.

## Before you open a pull request

Run the checks CI runs. A pull request must pass all of them:

```sh
npm run lint
npm run format:check      # npm run format fixes it
npm run build
npm run typecheck:tests
npm test
npm run test:browser
npm run check:boundaries
node scripts/gen-differences.mjs --check
npm run docs:api
npm run check:license
npm audit --omit=dev
```

If you changed an app, also run its browser test
(`npx playwright test -c apps/ghostline/test/e2e` or `-c apps/fieldnote/test/e2e`) and its demo
(`npm run demo:ghostline` or `npm run demo:fieldnote`).

CI runs on every push to `main` and `release/**` and on every pull request, on Ubuntu, Windows and
macOS (`.github/workflows/ci.yml`). A nightly workflow re-runs the property suites with random
seeds.

## Project rules

These are enforced by tests, lint rules or `npm run check:boundaries`:

- **No runtime dependencies** in any shipped package. Development tools are fine.
- **Determinism.** Engine code never calls `Date.now`, `new Date`, `performance.now` or
  `Math.random`; it uses the injected `Clock`, `Scheduler` and `Random`. State must be a pure
  function of the accepted operation set.
- **Every write takes a caller-supplied `mutationId`**, one per user intent, reused on retry.
  Never generate a new one inside a retry loop.
- **Boundaries.** `@weave/core` imports nothing outside itself (no `node:*`, no other package).
  The relay never imports resolvers, schemas or migrations. Apps import public entry points only
  and contain no sync, hashing or encoding code.
- **Never weaken a guarantee** (idempotency, determinism, convergence, integrity, crash recovery)
  to make a change smaller. Do not present unimplemented functionality as complete.
- TypeScript is strict (`strict`, `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`), ESM
  only. Every export is documented (`npm run docs:api` fails otherwise).

The rules come from the specification in `.kiro/specs/mission-build-weave-an-offline-first/` and
the steering files in `.kiro/steering/`. Changes to `packages/core/src/contracts/**` (the public
types) need a requirements-level reason; describe it in the pull request.

## Pull requests

- Keep each pull request to one purpose, and explain what changes and why.
- Add or update tests with every behaviour change. A bug fix should come with a test that fails
  without the fix.
- Update the documentation and add a line to `CHANGELOG.md` under `[Unreleased]` for user-visible
  changes.
- Significant design changes get an architecture decision record in `docs/adr/`.
- Do not change version numbers; releases are prepared separately.

## Reporting bugs

Open an issue at <https://github.com/realwarp/weave/issues> with:

- what you did, what you expected and what happened;
- your Node.js version, operating system and browser (for IndexedDB or app issues);
- the full error, including its WEAVE `code` and `details` if there is one.

Please do not include secrets such as relay tokens. For a problem you believe is a security
issue, open an issue that describes the impact without exploit details and ask for a private
contact.

## License

By contributing you agree that your contribution is licensed under the project's
[MIT License](LICENSE).

# Disclosure

## No prior code

No code of WEAVE existed before this project. Every file in this repository was written during
the Kiroween 2026 Skeleton Crew project, starting from an empty folder that held only the Kiro
specification in `.kiro/`. The repository's history starts with the first commit on 2026-11-24
(`Phase 0: repository, tooling, frozen contracts, vectors, CI, steering, ADRs`).

The specification itself (`.kiro/specs/mission-build-weave-an-offline-first/`: requirements,
design, tasks) was written with Kiro first and approved before implementation began. It is tracked
in this repository on purpose (R19.2), together with the steering files and hooks in `.kiro/`.

## Parent repository

The `WEAVE` folder sits inside a home directory (`C:\Users\ashwi`) that also contains a Git
repository. That parent repository has no commits and is not part of this project. WEAVE was
initialized as its own Git repository in `C:\Users\ashwi\Desktop\WEAVE` (`git init`), so its
history and files are independent of the parent repository, and nothing from the parent
repository was copied in.

## Third-party code

- **Runtime dependencies: none.** No shipped package depends on anything outside the `@weave/*`
  workspace (`npm audit --omit=dev` reports 0 vulnerabilities; see `docs/threat-model.md`).
- **Development tools** (not shipped): TypeScript, Vitest (with `@vitest/coverage-v8` and
  `@vitest/browser`), fast-check, ESLint with typescript-eslint, Prettier, Playwright, Vite, tsx and
  TypeDoc. They are listed in the root `package.json` and in `docs/adr/0011-dependencies.md`.
- **Reference material:** the canonical encoding follows RFC 8785 (JSON Canonicalization Scheme),
  and `tests/canonical-reference/` holds an independent reference implementation written for this
  project to cross-check the encoder. The RFC 8785 sample input is used as a test vector.

## AI assistance

The code, tests and documents were produced by Kiro agents working from the approved
specification, with independent reviewer agents checking each gate (`docs/reviews/`). The
workstreams and which agents produced what are described in `docs/kiro-crew.md`.

## License

WEAVE is released under the MIT License (`LICENSE`). Every `package.json` declares
`"license": "MIT"`, and `npm run check:license` verifies this together with the license file.

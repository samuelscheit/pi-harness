# Contributing

This repository is a reference implementation of one person's harness, so the bar for changes is "does this make the harness measurably better", not "is this configurable for everyone". Issues, questions and ideas are welcome. For larger changes, open an issue first, so we can agree on the approach before you write code.

## Setup

```sh
node scripts/install.mjs        # see docs/install.md for what this changes on your machine
```

Or, without installing, link the bundled Pi's dependencies and work on a checkout:

```sh
npm --prefix vendor/pi ci
ln -s vendor/pi/node_modules node_modules
npm --prefix dashboard ci
```

## Checks

```sh
npm run check      # tsc for the harness, the workflows and the dashboard
npm test           # node:test suite (test/*.test.ts) and the dashboard's vitest tests
```

Tests should be thorough, with edge cases, not smoke tests. Tests that need git create temporary repositories. Metrics tests use the seeded store in `test/seed.ts`.

## Conventions

- **Find the root cause.** Do not patch symptoms.
- **No legacy code.** When something is replaced, remove the old path entirely; there are no compatibility shims.
- **Evidence over taste.** Prompt and tool changes start as [experiments](docs/prompt.md#experiments) and are promoted from the comparison. Claims in comments and docs cite the measurement they come from.
- **Explain the why** at the top of each module: what failed before, and what the module does about it.
- **Commits** use [Conventional Commits](https://www.conventionalcommits.org/), with a body that explains the change like a pull-request description.
- **Bundled packages** (`vendor/pi`, `vendor/pi-lens`) are git subtrees. Keep local patches small, with a test, and note them in [docs/install.md](docs/install.md#bundled-pi-and-pi-lens).

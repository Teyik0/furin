# Contributing to Furin

Thank you for your interest in contributing to Furin! We appreciate every contribution, big or small.

## Prerequisites

- [Bun](https://bun.sh) (only supported runtime, never use Node, npm, yarn, or pnpm)

## Setup

```bash
git clone https://github.com/teyik0/furin.git
cd furin
bun install
```

## Development

```bash
bun run dev        # Run the example app with HMR
bun run build      # Build the library to dist/
bun run test       # Run tests
bun run test:types # Type-check without emitting
bun run fix        # Auto-fix lint issues
```

The monorepo is structured as:

- `packages/core/` — the Furin framework
- `apps/docs/` — documentation site
- `apps/scaffolder/` — `bun create furin` CLI
- `examples/` — example applications

## Before Submitting a Pull Request

Please make sure all of the following pass before requesting a review:

```bash
bun run fix && bun run test && bun run test:types
```

Unverified pull requests will not be reviewed until the checks are green.

## New Features

Open an issue first to describe the feature and discuss the approach before writing code. Tag a maintainer in the issue. Include test cases for any core functionality.

## Bug Fixes

Reference the related issue in your PR description. Provide a clear explanation of the bug and a reproducible case when possible. Add test coverage to prevent regressions.

## Code Style

- Biome via Ultracite is enforced — run `bun run fix` before committing
- Commits must follow [Conventional Commits](https://www.conventionalcommits.org/) (enforced by commitlint)
- Avoid default values for function parameters
- Avoid `null | undefined` for function parameters, types should be explicit

## Notes

- AI-generated pull requests without human review and supervision may be closed
- No plagiarism or unattributed code copying
- Be respectful and keep the community approachable

We're grateful for your time and effort. Happy hacking!

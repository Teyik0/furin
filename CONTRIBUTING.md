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
bun run tscheck # Type-check without emitting
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
bun run fix && bun run test && bun run tscheck
```

Unverified pull requests will not be reviewed until the checks are green.

## Development startup budgets

When the base revision supports the performance-report CLI, the performance CI
job measures Weather, Task Manager, and the documentation on both the base and
PR revisions, using three new `bun --hot` processes per app.
It compares medians for process-to-port, process-to-complete-first-HTML, and the
request duration of a first visit to another route. Responses must contain the
expected rendered content; an empty page or diagnostic response cannot pass.

Weather's Open-Meteo responses are fixed by a benchmark-only preload, and each
Task Manager sample uses a fresh temporary database. Builds run before these
measurements; filesystem and generated caches remain present. This is process
cold start, not a cold machine or an empty-cache benchmark. Browser hydration
is not included. Each metric allows the larger of 500 ms or 30% of the baseline.

```bash
bun scripts/measure-dev-startup.ts /path/to/base /tmp/startup-base.json
bun scripts/measure-dev-startup.ts /path/to/pr /tmp/startup-head.json
bun scripts/compare-dev-startup.ts /tmp/startup-base.json /tmp/startup-head.json /tmp/startup.md
```

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

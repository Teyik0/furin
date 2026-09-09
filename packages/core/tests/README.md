# Core Test Architecture

Furin core tests are organized by behavior, not by the internal `src/` layout.
New tests should describe what Furin does through public or intentionally exposed
test interfaces. Avoid coupling tests to private implementation details when the
same behavior can be verified through `furin`, route definitions, generated
build output, or an Elysia request.

## Where Tests Go

- `contract/`: public types, exports, and DX contracts.
- `routing/`: file discovery, route conventions, layouts, validation, not-found
  and routing cache behavior.
- `rendering/`: SSR, RSC, deferred data, templates, and render-time errors.
- `client/`: link/navigation behavior, browser-like DOM tests, sync client, and
  client boundaries.
- `build/`: CLI config, adapters, hydrate entries, embedded builds, and bundle
  measurement.
- `runtime/`: Furin as an Elysia plugin, request scope, invalidation,
  multi-instance behavior, and runtime instance state.
- `dev/`: dev-mode and HMR behavior that needs Bun hot reload or subprocesses.
- `architecture/`: dependency rules and structural invariants.

## File Suffixes

- `*.test.ts` / `*.test.tsx`: normal behavior tests.
- `*.integration.test.ts` / `*.integration.test.tsx`: subprocess, server, or
  slow cross-module scenarios.
- `*.dom.test.tsx`: DOM-specific tests when a separate suffix makes the runtime
  requirement clearer.
- `*.type.test.ts` / `*.type.test.tsx`: compile-time type contracts.
- `*.scenario.ts` / `*.scenario.tsx`: Worker entrypoints invoked by a colocated
  test when process-global module state requires isolation; these are not test
  runner entrypoints themselves.

Use the suffix to communicate execution cost. Use the folder to communicate
which Furin behavior is covered.

## Fixtures And Temporary Files

Versioned fixtures live under `fixtures/`:

- `fixtures/apps/`: complete app fixtures copied by `createTmpApp`.
- `fixtures/pages/`: page-tree fixtures used by route discovery and rendering
  tests.

Generated files must not be written under `tests/`. Use `packages/core/.tmp-tests`
through `support/app-fixtures.ts` for temporary apps and outputs.

## Support API

Reusable test support lives under `support/`. Keep this folder small and
explicit:

- `app-fixtures.ts`: creates temporary app copies from `fixtures/apps`.
- `process.ts`: runs the Furin CLI or long-lived subprocesses.
- `dom.ts`: installs and resets the DOM environment.
- `hmr.ts`: HMR-specific process and port helpers.
- `http.ts`: HTTP polling helpers.

Do not add generic helpers until at least two tests need the same behavior.

## HTTP And Subprocesses

Prefer `app.handle(new Request("http://..."))` for Elysia behavior. Start a real
server only when the behavior requires a bound port, Bun HMR, or process-level
state.

Use subprocess tests for global module state, Bun `--hot`, or scenarios that
cannot be isolated safely inside the current Bun test process. Mark those tests
with `.integration.test.ts` when they are intentionally slow or process-heavy.

## DOM And Browser Tests

DOM tests should opt in through `support/dom.ts`. Do not register `happy-dom`
from the global preload because most core tests should keep Bun's native Web
APIs.

Use `Bun.WebView` only for browser-level integration tests that need a real
browser runtime, such as hydration, trusted click/input events, or client
navigation. Put those tests under `browser/` with a `.webview.test.ts` suffix and
gate them behind `FURIN_WEBVIEW_TESTS=1` until the tier is stable in CI. The
`test:webview` script runs the HMR browser conformance tier, including React
boundaries, import graphs, error recovery, CSS, route topology, concurrent
loaders, multi-tab reconnects, multiple prefixed instances, and the
SSR/SSG/ISR/defer/RSC matrix. Known Bun-backed pipeline gaps use `test.failing`: they
remain executable and become failures if the expectation unexpectedly starts
passing, forcing an explicit review and promotion into the supported matrix.
The longer soak is
opt-in through `test:hmr:soak`; it performs 2,000 edits by default and reports
Chrome heap, server RSS, and edit latency samples. Set `FURIN_HMR_SOAK_EDITS`
to a smaller count for a local smoke test.

## Commands

From `packages/core`:

```sh
bun test
bun test tests/routing
bun test tests/rendering/deferred
bun test tests/client/link
bun test tests/contract
bun run test:webview
bun run test:hmr:soak
```

From the repository root:

```sh
bun run test
bun run tscheck
bun run build
bun run fix
```

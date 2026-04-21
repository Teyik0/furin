# Changelog

All notable changes to Furin will be documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0-alpha.10] — 2026-04-20

### Added
- **Segment-level error and not-found boundaries** — `error.tsx` and `not-found.tsx` conventions at any directory under `src/pages/` catch errors and missing content for every route that passes through that segment. Root-level `src/pages/error.tsx` and `src/pages/not-found.tsx` catch everything else.
- **`FurinErrorBoundary` and `FurinNotFoundBoundary`** — React class-component boundaries that catch loader and render errors at the segment level. `FurinErrorBoundary` computes a digest at catch time, supports `onReset`/`resetKey`, and lets `FurinNotFoundError` bubble up to the nearest not-found boundary.
- **`notFound(options)` helper** — throw `notFound({ message, data })` from any loader to render the nearest `not-found.tsx` with status `404`.
- **Error digests** — every caught error receives a deterministic 10-hex-char digest (e.g. `00a3f2b9c1`). The same digest is logged server-side next to the full stack trace so support can correlate user reports without leaking internals to the browser.
- **`ErrorProps` and `NotFoundProps` types** exported from `@teyik0/furin` for custom boundary components.
- **Default styled fallback screens** — built-in `500 — ERROR` and `404 — NOT FOUND` pages with inline styles (no CSS dependency), a digest code display, and a "Try again" button that re-runs loaders.
- **SPA 404 inline rendering** — when client-side navigation hits an unmatched URL, the router detects `__furinStatus: 404` in the fetched HTML and renders the not-found UI inline instead of forcing a full-page reload.
- **Segment boundaries** — each `ResolvedRoute` carries a `segmentBoundaries` chain ordered shallow→deep, mirroring the Next.js app-router model. The client uses this chain to interleave `FurinErrorBoundary` / `FurinNotFoundBoundary` wrappers at the exact same nesting levels as the server.
- **Client-side boundary interleaving** — `buildPageElement` (client) and `buildElement` (server) both wrap the page subtree with boundaries at the depths declared in `segmentBoundaries`, guaranteeing identical React trees for hydration.
- **Prefetch cache with stale-while-revalidate** — `RouterProvider` maintains an in-memory prefetch cache keyed by logical href. Entries expire after `preloadStaleTime` (default 30 s). The `prefetch` function preloads both the HTML payload and the JS chunk in parallel.
- **Stale-deploy detection** — each production build has a build ID injected into `index.html` and emitted as `X-Furin-Build-ID`. If the client detects a mismatch during SPA navigation, it triggers a full-page reload instead of mounting stale components.
- **Scroll restoration** — manual scroll restoration with `history.state` keys. Scroll positions are saved to `sessionStorage` on navigation and restored on back/forward. Hash fragments scroll to the target element after React paint.
- **`applyRevalidateHeader` and `shouldAutoRefreshPath`** — client utilities that process the `X-Furin-Revalidate` header to invalidate prefetch caches and optionally auto-refresh the current page.
- **Error Handling documentation** — new `/docs/error-handling` page covering `error.tsx`, `not-found.tsx`, `notFound()`, digests, root fallbacks, SPA 404 handling, and ISR error behavior.
- **Observability for catch-all 404s** — `renderRootNotFound` now emits a structured `useLogger().set()` entry with `furin: { render: "not-found", action: "catch_all", path }` before rendering the SPA 404 shell. When the dev-mode loopback template request fails, the swallowed error is logged as `furin: { render: "not-found", action: "dev_template_fallback", error }` so template outages are visible.
- **ISR non-200 branch shell recovery** — the non-200 ISR path in `handleISR` now mirrors the SSR shell-recovery behaviour: if `renderToReadableStream(element)` throws (e.g. a broken user `error.tsx` component), it falls back to `buildErrorElement(undefined, ...)` (the built-in `DefaultErrorComponent`) so the ISR response cannot crash entirely.
- **Structured logging for non-200 ISR responses** — after a non-200 ISR render (404 or 500), `handleISR` logs `furin: { render: "isr", route, cache: "miss", render_ms, digest?, status }` so ISR misses are observable even when they do not hit the 200 path.

### Changed
- `computeErrorDigest` now uses a platform-neutral FNV-1a implementation instead of `Bun.hash`, so error digests work correctly in both server and client environments.
- `prepareRender` now requires both `basePath` and `throwOnFailure` arguments explicitly — no optional or defaulted parameters.
- `notFound(options)` and `FurinNotFoundError.constructor(options)` now accept `NotFoundOptions | undefined` explicitly. Callers must pass the value or `undefined` deliberately.
- `loadProdRoutes` now requires `CompileContext` to include `rootConventions` and `routeMetadata`. Production builds fail fast with a clear error if boundary metadata is missing, preventing silent drops of error/not-found conventions.
- `handleISR` non-200 render logic extracted to a dedicated `renderISRNon200` helper to keep the public function under the cyclomatic-complexity threshold.

### Fixed
- **Public error message sanitization** — the built-in default error screen shows a generic message (`"Something went wrong"`) for untrusted errors. Custom `error.tsx` components still receive the raw `error.message`. `error.digest` is always exposed for support correlation.
- **ISR fallback renders are no longer cached** — when an ISR cache miss results in a loader error or `notFound()`, the response is returned with the correct status (`404`/`500`) and conservative `Cache-Control` headers. The in-memory ISR cache is not populated, so the next request re-attempts the render.
- **`classifySpaResponse` misclassification** — server errors that happened to carry `__furinStatus` in the body are no longer incorrectly treated as not-found. The 404 branch is now guarded by the HTTP status being `2xx` or `404`.
- **Hydration not-found mismatch** — when a matched route's loader throws `notFound()`, the hydration entry now passes the not-found payload into `initialNotFound` instead of `undefined`, so the client hydrates into the correct 404 state.
- **`buildErrorElement` leak** — the default error component no longer receives raw error messages. Custom error components continue to receive raw messages via `errorMessageOf`.
- **`refreshLayoutChain` index drift with gap directories** — directories without a `_route.tsx` file were previously skipped with `isModuleNotFoundError`, but the old code used positional parity (`chainIdx = i + 1`) between `layoutPaths` and `chain`, causing layout/loader updates to be applied to the wrong chain entries. The loop now tracks `chainIdx` independently and only advances it when a `_route.tsx` import succeeds, preventing HMR layout corruption in nested routes with intermediate directories that do not declare a `_route.tsx`.
- **`resolveMode` treated `revalidate: 0` as SSR** — an explicit `revalidate: 0` on a route config or page object now correctly resolves to `"isr"` instead of falling through to `"ssr"`. `revalidate: 0` is valid ISR (no CDN caching, always re-render).

## [0.1.0-alpha.9] — 2026-04-18

### Added
- **Structured logging** — `evlog` is now wired in on both sides of the stack with no setup required. `log` is injected directly into the loader context (`({ params, log }) => ...`) and resolves the correct logger for every rendering mode: request-scoped wide event for SSR, detached `createLogger()` for ISR background revalidation and SSG pre-renders, no-op outside any context.
- `log: RequestLogger` added to `RouteContext` — fully typed, available via destructuring in all loaders.
- Drain adapters documented: Datadog, Axiom, OTLP, Sentry, HyperDX, Better Stack, PostHog, filesystem.

### Fixed
- `useLogger()` from `evlog/elysia` throws during ISR background revalidation and SSG pre-renders (evlog ALS is empty outside a live request). Furin now provides a `context-logger` fallback chain: live request → synthetic render scope → no-op. The error no longer crashes background renders.
- `mergeRouteSchemas` now preserves Object-level TypeBox options (`additionalProperties`, `$id`, `description`, etc.) when merging parent and child query/params schemas — previously only `properties` were kept.
- `scrollRestoration` is now restored to its prior value on `RouterProvider` unmount instead of unconditionally resetting to `"auto"`.

## [0.1.0-alpha.8] — 2026-04-18

### Fixed
- macOS binary code signing for compiled Bun executables (`--compile`)
- Static build target and HMR stability improvements
- Hydrate file now hashed during build to prevent stale caching on immutable assets

## [0.1.0-alpha.7] — 2026-04-12

### Added
- `knip` integration for dead-code detection

### Fixed
- Type system edge case when a route function has an explicit return type annotation
- Build output order corrected for server + client assets

## [0.1.0-alpha.6] — 2026-04-07

### Added
- ISR revalidation and caching support in `createRoute()`
- `apps/scaffolder` — `bun create furin@latest` scaffolder CLI, including `--template full` (shadcn/ui starter)
- Task-manager example app with Suspense boundaries

### Fixed
- Security improvements in server request handling
- Better resolution of the `public/` directory
- Miscellaneous bugfixes across SSR and build paths

## [0.1.0-alpha.5] — 2026-04-01

### Added
- Weather example application

## [0.1.0-alpha.4] — 2026-03-27

### Changed
- Package renamed to `@teyik0/furin` (scoped npm package)
- Project renamed from `furinjs` to `furin`

### Added
- Dev workflow improvements

## [0.1.0-alpha.3] — 2026-03-15

### Added
- `furin build` CLI with `--target bun` and `--target static` support
- `--compile` flag for producing self-contained Bun binaries (`server` and `embed` modes)
- `furin.config.ts` with `defineConfig()` for plugins and config

## [0.1.0-alpha.2] — 2026-03-09

### Added
- Split-chunk hydration: per-route bundles to reduce initial JS payload
- Extended `RouteContext` with full Elysia context (headers, store, decorators…)

### Changed
- Dev mode now uses Bun's native HTML bundler — no more custom HMR server, single process

### Fixed
- Various stability fixes in dev mode and routing

## [0.1.0-alpha.1] — 2026-02-21

### Added
- File-based routing from `src/pages/`
- Nested layouts with `_route.tsx`
- SSR, SSG, and ISR rendering modes via `createRoute()`
- Typed `params`, `query`, loader data, and `<Link />` search objects
- `RouterProvider`, `useRouter`, and `<Link />` with preload strategies (`intent`, `viewport`, `render`)
- SPA navigation with `history.pushState` and `popstate` support
- `writeRouteTypes()` generating `furin-env.d.ts` for per-route type inference
- Bun-native HMR with React Fast Refresh — single process, no Vite

[Unreleased]: https://github.com/teyik0/furin/compare/v0.1.0-alpha.10...HEAD
[0.1.0-alpha.10]: https://github.com/teyik0/furin/compare/v0.1.0-alpha.9...v0.1.0-alpha.10
[0.1.0-alpha.9]: https://github.com/teyik0/furin/compare/v0.1.0-alpha.8...v0.1.0-alpha.9
[0.1.0-alpha.8]: https://github.com/teyik0/furin/compare/v0.1.0-alpha.7...v0.1.0-alpha.8
[0.1.0-alpha.7]: https://github.com/teyik0/furin/compare/v0.1.0-alpha.6...v0.1.0-alpha.7
[0.1.0-alpha.6]: https://github.com/teyik0/furin/compare/v0.1.0-alpha.5...v0.1.0-alpha.6
[0.1.0-alpha.5]: https://github.com/teyik0/furin/compare/v0.1.0-alpha.4...v0.1.0-alpha.5
[0.1.0-alpha.4]: https://github.com/teyik0/furin/compare/v0.1.0-alpha.3...v0.1.0-alpha.4
[0.1.0-alpha.3]: https://github.com/teyik0/furin/compare/v0.1.0-alpha.2...v0.1.0-alpha.3
[0.1.0-alpha.2]: https://github.com/teyik0/furin/compare/v0.1.0-alpha.1...v0.1.0-alpha.2
[0.1.0-alpha.1]: https://github.com/teyik0/furin/releases/tag/v0.1.0-alpha.1

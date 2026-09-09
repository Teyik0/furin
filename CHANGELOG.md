# Changelog

All notable changes to Furin will be documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Breaking
- **Strict route builder contract** — `defineRoute()` now exposes only `.config()` before `loader`/`page`/`layout` become reachable, and `.config()` requires `layout: <route>` and `mode` at minimum. The types-only parent reference is renamed from `parent` to `layout` and the overload matrix collapses from 8 signatures to 4 (one per schema shape); omitting `layout` keeps the route parentless. A new `defineRootRoute()` (the `createRootRoute` analogue) covers `pages/root.tsx` with `.config({ mode })` and no layout.

### Added
- **Elysia route builder** — legacy route definitions are replaced by a typed `defineRoute()` builder with schema-shaped overloads, `defineRootRoute()` for the root layout, and `Link` props gaining typed `params?: RouteParamsOf<To>` derived from the route's params schema (schema numbers accept both `42` and `"42"`).
- **TanStack-style layout auto-fix** — the dev topology watcher verifies every route file's `.config` against the file-system tree and rewrites missing or misplaced `layout` references (plus a default `mode: "ssr"`), inserting the import when needed. Idempotent by construction and safe: content edits never retrigger the watcher.
- **Hot-added routes served without restart** — the topology watcher rebuilds the native renderer in place (route matcher swap) and the global NOT_FOUND handler consults the fresh renderer, so hot-added routes are served (~250 ms) and hot-removed routes 404 without restarting the dev server.
- **Stricter layout auto-import** — auto-import of parent layouts uses stricter and safer rules.
- **parentData conflict surfacing** — a child loader key that shadows a parent key with an incompatible type surfaces a readable branded error at the read site; same-name-same-type overrides stay legitimate. A dev-only warning fires when a deeper loader silently overwrites a key inherited from its layout chain. Loader keys `params`/`query`/`path` are rejected as they are overwritten by route context.

### Changed
- **Single route-type generator** — one shared `routeMapDeclaration()` generator (segment-based key with escaping) now backs `writeRouteTypes` (RouteMap + FurinCacheTags, atomic content-diff write); the plugin-side duplicate generator and its test are removed.
- **Incremental route-module cache** — route modules are re-evaluated only when their mtime changed (path→mtime cache), replacing the blanket cache-busting on every resolution.
- **Private route files ignored** — route discovery skips underscore-prefixed files and directories, so co-located `_components.tsx` files no longer become routes; the `_route` layout convention is preserved.
- **Documentation for the strict builder** — snippets declare complete `.config({ layout, mode })` with copy-paste-compilable imports, `defineRootRoute()` for root layouts, and prose updated from `config({ parent })` to `config({ layout })`.

### Fixed
- **React Doctor diagnostics** — all 25 warnings resolved: PostgreSQL migration uses `sql.file()` instead of `sql.unsafe(string)`; weather API fetches check `res.ok` before reading the body; `Promise.all` on independent PostgreSQL stream queries and several single-pass loops / cached lookups (perf); targeted CSS transitions instead of `transition-all` across examples and the scaffolder template.
- **React Doctor pre-commit gate runs offline** — the supply-chain (Socket.dev) and score network calls no longer hang commits on blocked networks; the full networked scan belongs to CI or manual runs.

## [0.3.0-alpha.1] — 2026-08-21

### Breaking
- **Strict public route types** — `RuntimeRoute`, `RuntimePage`, the obsolete `PageConfig`, and the phantom `RouteRef`/`route.ref` API have moved out of the public client contract. Route inference now uses hidden type-only symbols, accepts named loader-data interfaces without index signatures, hides deferred runtime metadata, and accepts readonly cache-tag arrays.
- **Minimum Bun version** — Bun 1.4.0 is now required to avoid a runtime crash when updating RSC content.
- **Explicit sync runtime** — `furinSync()`, `createSyncStreamPlugin()`, and active `furin({ sync })` configurations now require a shared runtime object. The `sync: true` and no-argument development shorthands, `MemorySyncAdapter`, and `MemorySyncNotifier` have been removed; `sync: false` remains available to disable sync explicitly. SQLite `:memory:` replaces the development storage implementation and remains rejected in production.
- **Consolidated sync adapter exports** — the unpublished adapter workspaces have moved into `@teyik0/furin/sync/postgres`, `@teyik0/furin/sync/redis`, and `@teyik0/furin/sync/sqlite`; no compatibility packages are published.

### Added
- **Native Furin DevTools** — development pages now receive a zero-config Shadow DOM panel automatically, with route discovery, correlated request and loader timings, ISR/SSG cache hit/miss/stale state, invalidations, sync-stream cursors, browser Resource Timing bundle sizes, and RSC/route payload sizes. A build-time instrumentation boundary keeps the panel, client asset, event hub, request context, marker strings, and internal snapshot/SSE transport out of production application bundles and compiled binaries. DevTools never exposes loader values and can be hidden or restored with `Cmd/Ctrl+Shift+.`.
- **SQLite sync adapter** — the `@teyik0/furin/sync/sqlite` subpath implements atomic leases, replay responses, and cursor catch-up with `bun:sqlite`. Its scope is `process-local` for memory databases and `host-local` for file-backed databases.
- **Distributed sync adapters** — the `@teyik0/furin/sync/postgres` and `@teyik0/furin/sync/redis` subpaths provide durable cross-replica idempotency, mutation leases, replay, and ordered change journals using Bun's native SQL and Redis clients. PostgreSQL ships an idempotent schema bootstrap and migration CLI; Redis also exports an independent best-effort notifier.
- **Injectable sync runtime** — `SyncAdapter` durable storage is separate from `SyncNotifier` wake-ups. The core includes cursor polling for safety, atomic mutation completion, lease renewal, and a common public adapter conformance suite.
- **Sync bundle isolation coverage** — build fixtures verify that core, SQLite, PostgreSQL, Redis, hybrid, and browser bundles contain only their imported backends from the single side-effect-free package.
- **Composite React Server Components** — `furin/rsc` now exports explicit RSC primitives for loader-returned server markup. `renderServerComponent()` transports server-rendered React output through SSR and SPA data responses, while `createCompositeComponent()` and `<CompositeComponent>` let client-owned `children`, component slots, and render props compose into server-owned markup without turning the whole route into client JavaScript.
- **Partial prerendering for personalized cached routes** — `createRoute({ requestLoader })` separates request-specific data from the public route loader. SSG/ISR routes can cache the public shell while streaming `requestData` per request under Suspense; pure static export rejects `requestLoader` because no request runtime exists.
- **RSC build graph and runtime guards** — Bun builds now emit the isolated Flight codec graph, enforce matching React / React DOM / React Server DOM versions, and provide `furin/server-only` plus `furin/client-only` imports for build-time graph boundary assertions.
- **RSC documentation and example route** — the rendering guide now documents composite RSC, request-scoped data, and the current tradeoffs against Next.js-style default Server Components. The task-manager example includes an `/rsc` route and production transfer-size comparison against the conventional ISR route.

### Changed
- **Production sync requires durable storage** — every environment now passes an explicit runtime. Production rejects process-local adapters, file-backed SQLite is supported for one machine, and PostgreSQL or Redis remains required across hosts.
- **Optimistic sync runs before network work** — `useSync()` applies its optimistic callback synchronously, while cursor-only notifications and coalesced catch-up keep UI response independent of network latency.
- **Route data transport now supports Flight payloads** — SSR and `/_furin/data` switch to the route-frame stream when loader data contains RSC sources, preserving nested/cyclic data, deferred values, and SPA navigation compatibility.
- **Build IDs cover server-rendered output more completely** — Bun and package target fingerprints now include route metadata, source contents, framework render pipeline inputs, and mounted-app prefixes so SSR-only changes trigger stale-deploy detection.
- **Core test execution uses Bun directly** — the root and core `test` scripts now run workspace Bun tests without the deleted shell harness, and DOM/browser test guidance documents when to opt into `happy-dom` or WebView.
- **Yuku parser packages upgraded** — `yuku-parser` and `@yuku-toolchain/types` moved to `0.6.1`; the parser dependency architecture test now verifies the direct parser dependency without pinning the exact patch in the assertion.

### Fixed
- **Build reliability** — paths produced by `staticParams()` are now validated before client bundling or output-directory creation, and long-running build adapter tests signal completion explicitly under Bun's parallel runner.
- **Collision-free deferred metadata** — `defer()` now uses one internal runtime symbol for branding, removing unsafe type assertions while preserving user loader fields named `__isDeferred`.
- **Sync invalidation durability** — synced handlers now preserve manual `revalidatePath()` and `revalidateTag()` results alongside declarative invalidations in the durable change journal without duplicating identical paths.
- **PostgreSQL idempotency key bounds** — the PostgreSQL sync adapter now stores fixed-size SHA-256 mutation keys, preventing long request paths or idempotency keys from exceeding btree index-entry limits.
- **SQLite cursor precision** — SQLite sync streams now preserve exact 64-bit cursors beyond JavaScript's safe-integer range, preventing rounded cursors from losing or duplicating retained changes.
- **Sync adapter durable invariants** — SQLite now rejects succeeded mutation rows without replay data, preserves renewed in-progress leases past mutation-retention expiry, and reports SQLite failures as rejected promises; PostgreSQL migration reruns now add the replay-data check to existing tables.
- **Sync stream catch-up reliability** — SSE `open` is now the single post-connect catch-up trigger, preventing duplicate requests without allowing a failed earlier attempt to suppress recovery.
- **Distributed sync validation hardening** — third-party GitHub Actions in the database-backed validation workflow are pinned to reviewed commit SHAs.
- **React Doctor diagnostics** — docs search now lets TanStack Query schedule index fetching without effect-driven refetches, and the task-manager example respects reduced-motion preferences for animated UI.
- **Distributed sync correctness** — reconnects now catch up without relying on a new SSE notification; notifier subscriptions and polling are race-safe; lease renewal continues during slow adapter calls; SQLite and Redis cursors, retention, snapshots, and replay expiry follow adapter invariants; and PostgreSQL prevents incomplete replay rows.
- **Locale-independent build fingerprints** — route fingerprint sorting now uses code-unit ordering instead of locale-sensitive collation, preventing build-ID differences across host locales.
- **Static export route coverage** — dynamic SSG routes without usable `staticParams()` now fail the default static build instead of being silently omitted, and static build manifests now list rendered and skipped routes deterministically.
- **Scaffolder duplicate outputs** — project generation now fails before writing files when a template contains duplicate destination paths.
- **Sync refresh test coverage** — RouterProvider sync tests now exercise the full `EventSource` notification, `/_furin/sync/changes` catch-up, and current-page refresh flow, while SSE/RSC stream assertions use explicit operation timeouts.
- **Scaffolder path traversal guards** — template sources and generated destinations are now rejected when they escape the templates or target directory.
- **Client transform reliability** — server-only route properties are stripped only from Furin `createRoute()` and `route.page()` calls, including aliased imports and imported route bindings, without touching unrelated `.page()` calls.
- **Reserved loader metadata keys** — loader data fields starting with `__furin` now fail fast instead of colliding with framework transport metadata.
- **Ambiguous route discovery** — duplicate normalized route patterns and page-file / same-name-directory collisions now throw deterministic startup errors.
- **SPA data endpoint params validation** — `/_furin/data` now validates and coerces path params with the route `params` schema before running loaders, matching full SSR requests.
- **RSC and deferred route-frame streaming** — SSR and SPA data responses now stream deferred values through the route-frame transport, including deferred RSC resolution and rejection during hydration.
- **ISR cache query variants** — ISR and dev ISR caches now key entries by path and search params, preserve the search string during background revalidation, and clear every query variant during path revalidation.
- **ISR invalidation races** — in-flight background revalidation can no longer repopulate an entry after explicit invalidation, and pending revalidations are scoped per Furin instance.
- **Prefixed cache purges** — `revalidatePath()` now purges mounted apps by their physical prefixed URL instead of the logical app-local path.
- **PPR tag invalidation** — partial-prerender public-shell caches are instance-scoped, registered with the cache invalidator, and cleared by `revalidateTag()`.
- **Sync mutation replay bounds** — `furinSync()` now replays bounded `Response` bodies, rejects unbounded or oversized response bodies safely, and does not re-execute retries for unreplayable mutation responses.
- **Docs table-of-contents cleanup** — pending hash-scroll animation frames are cancelled on unmount, satisfying React effect cleanup checks.

## [0.2.0-alpha.5] — 2026-07-12

### Added
- **Multi-instance mounting with `prefix`** — several `furin()` apps can now be composed into one Elysia server, each under its own mount prefix: `new Elysia().use(await furin({ pagesDir: "./src/pages" })).use(await furin({ pagesDir: "./src/admin", prefix: "/admin" }))`. Pages, framework endpoints (`/_furin/*`), client assets, and the client bundle's `basePath` all live under the prefix; mounting two different apps on the same prefix throws at startup.
- **Per-instance runtime state** — build IDs, SSG/ISR/dev-loader caches, HTML templates, auto-invalidate registries, and sync streams are now scoped to the owning furin instance (requests are bound to their instance by path via the request-scope wrap). `revalidatePath`/`revalidateTag` intentionally stay cross-app so shared-data invalidation keeps working; sync publications notify every sync-enabled app.
- **Multi-app builds** — `furin build` detects every `furin({ pagesDir, prefix })` call in the server entry (or takes an explicit `apps` list in `furin.config.ts`) and produces one client bundle per app (`client/`, `client-admin/`, …) plus a single server artifact, including `--compile`/`--compile embed`.
- **`furin build --target package`** — builds an app as a publishable prebuilt Elysia plugin: a self-registering `register.js` (page modules bundled, all node_modules external), a `createFurinApp()` factory, and the app's client assets. Hosts compose micro-frontends with `.use(await createFurinApp())`; monorepo dev keeps live HMR through the same factory.
- **`furin({ clientDir })` option** — production apps (notably packaged ones) can point at an explicit client-assets directory instead of relying on auto-resolution.
- **Multi-instance documentation** — new "Multi-Instance & Micro-Frontends" guide covering prefixes, isolation semantics, multi-app builds, and packaged apps.

### Changed
- **Prefixed instances render their own 404** via an instance-scoped catch-all; the root-mounted app keeps the historical global NOT_FOUND handler (a parent `.onError` registered before `.use(furin)` still wins).
- **furin's lifecycle hooks no longer use global scope** — they stay local to the mounted instance so they can't leak onto sibling apps in the same server.
- In multi-instance dev, each app writes its generated files to its own `.furin/<prefix>` directory; `furin-env.d.ts` (typed links) is generated by the root app only.

## [0.2.0-alpha.4] — 2026-06-28

### Added
- **Replayable, idempotent sync mutations** — every mutation handled by `furinSync()` now requires an `Idempotency-Key`, stores its successful response, and replays that response when the same request is retried. Reusing a key with a different payload or while the original request is still running returns `409`; routes with non-replayable effects can opt out with `sync: false`.
- **Cursor-based sync catch-up** — the SSE stream now announces cursors while `/_furin/sync/changes` returns ordered invalidations missed during disconnects. The client catches up after reconnecting and falls back to a full layout refresh when retained history is no longer sufficient.
- **Sync adapter foundation** — the sync engine now has a strict adapter contract for mutation replay, ordered change history, and subscriptions. The built-in in-memory adapter retains up to 1,000 changes and 10,000 mutations for 24 hours; its state remains process-local and is lost on restart.
- **Replayable sync documentation** — API, configuration, caching, and package documentation now describe idempotency keys, automatic mutation synchronization, opt-out cases, catch-up behavior, and the limitations of the in-memory adapter.

### Changed
- **Mutations are synchronized by default under `furinSync()`** — non-`GET`/`HEAD`/`OPTIONS` routes no longer need an explicit sync declaration. The optional `sync` route object is only needed to declare cache invalidations, and `SyncRouteOption` is now exported for typed integrations.

### Fixed
- **Superseded navigation aborts** — aborts from an older navigation no longer surface as errors after a newer navigation has taken over.
- **Deferred refresh cancellation** — deferred NDJSON and SSR streams now stop cleanly when a sync refresh is superseded, without leaking abort errors or stale results.
- **Coalesced refresh invalidations** — invalidations received while a refresh is already in flight are preserved and applied by the follow-up refresh instead of being dropped.

## [0.2.0-alpha.3] — 2026-06-27

### Added
- **Live mutation sync engine** — `furin({ sync: true })` mounts an internal Server-Sent Events stream at `/_furin/sync` and injects the client runtime automatically. A custom stream path remains available for constrained reverse-proxy deployments.
- **`furinSync()` Elysia plugin** — API mutations can declare path or tag invalidations through a typed `sync` route option. Successful mutations broadcast those invalidations to connected browsers while keeping regular Elysia routes and Eden Treaty as the public API contract.
- **`useSync()`** — new client hook exported from `@teyik0/furin/client` adds an `Idempotency-Key` to typed mutation calls and provides focused `optimistic`, `onSuccess`, and `onError` callbacks with rollback support.
- **Automatic live refreshes** — the router listens for sync invalidations, clears affected prefetch entries, and refreshes the current page when its path or layout data becomes stale.

### Fixed
- **Per-instance sync stream isolation** — Furin instances and custom stream paths no longer share subscribers or broadcast invalidations across application boundaries.
- **Failed mutation retries** — failed mutations no longer consume their idempotency key, allowing a corrected retry to execute normally.
- **Windows path handling** — build and dev-server path normalization now works with Windows drive-letter and separator conventions; related temporary-app and segment-boundary tests are portable across platforms.

## [0.2.0-alpha.2] — 2026-06-13

### Added
- **`useSearch`** — new hooks exported from `@teyik0/furin/search` for reading and mutating URL query params with full type safety. `const [search] = useSearch("/products")` returns the server-resolved query object for the current route. `const [_, setSearch] = useSearch("/products")` patches the current search and navigates to the updated URL (push or replace). Both are typed from the generated `furin-env.d.ts` route manifest.
- **Route-chain query schema merging** — when a route chain contains multiple `query` schemas (e.g. a layout `_route.tsx` with `query: t.Object({ sort: t.String() })` and a page with `query: t.Object({ page: t.Number() })`), the generated `furin-env.d.ts` merges them into a single `{ sort?: string; page?: number }` search type for that route. `mergeRouteSchemas` now validates that all chained schemas are TypeBox objects (throws a clear error if a non-TypeBox schema is mixed in the chain).
- **Default-value fields are present in generated types** — query fields declared with `t.Optional(t.String({ default: "all" }))` (or any non-null `default`) are emitted as required properties in `furin-env.d.ts`. The runtime still validates them as optional, but the type system reflects the guaranteed presence after Elysia validation applies the default.

## [0.2.0-alpha.1] — 2026-06-10

### Added
- **Client-side `evlog` logging is now opt-in** — `furin.config.ts` supports `clientLogging: true` to ship structured evlog events from the browser. Previously enabled by default; now disabled by default to reduce bundle size for apps that do not need it.
- **Real error messages in dev when no `error.tsx`** — if a route has no custom `error.tsx` boundary, the dev-mode error page now surfaces the actual error message and stack trace instead of the generic fallback.

### Changed
- **Core restructured into `server/`, `client/`, and `shared/` directories** — all source files in `packages/core/src` are now organized by runtime boundary. This replaces the previous flat layout and makes it immediately obvious which code runs where.
- **Enforced import layering** — CI and a test guard (`test(core): enforce server->client->shared layering`) prevent `server/` from importing `client/` or `shared/` from importing either. The `build.ts` file is the only allowed bridge.
- **`furin.ts` relocated to package src root** — the main library entry point is now at `packages/core/src/furin.ts` for clearer path resolution.
- **Extracted shared HTML route-cache factory** — deduplicated cache construction logic between SSR and ISR render paths.
- **Extracted shared shell-error fallback** — the server-side shell recovery when `renderToReadableStream` throws is now a single shared helper.
- **Deduped ISR ETag formatting** — ETag string construction is now centralized.
- **Migrated `react-doctor` config to TypeScript** — with path remapping for cleaner type checking.

### Fixed
- **Docs search dialog** — `useQuery` results are now destructured correctly in the search dialog component.
- **Yuku parser upgrade** — upgraded to a version with better TypeScript types, removing manual type workarounds.
- **CI and test flakiness** — multiple review comment fixes and CI stability improvements.

## [0.1.0-alpha.15] — 2026-05-24

### Added
- **`defer()` in layout loaders** — `createRoute({ loader })` can now return `defer({...})`. Deferred fields from layouts and pages are streamed together over a single transport (SSR `<script>` chunks or `/_furin/data` NDJSON), letting a layout flush its shell (nav, sidebar) while a slow widget streams in. The previous v1 restriction that fail-fast'd a deferred layout loader is removed.

### Fixed
- **Tag-based revalidation now survives SPA navigation** — `/_furin/data` (the SPA loader-fetch endpoint) did not re-register the route's `tags` after running its loader, so the first mutation would invalidate the path and drop its tag mapping while subsequent mutations on the same tag found no path and the `x-furin-revalidate` header was silently omitted. The data endpoint now registers loader tags on every successful run, mirroring the full-HTML render path.
- **Cross-map cleanup on layout/page key collision** — when a layout returned `defer({stats: Promise})` and the page returned `{stats: 42}` (or vice-versa), both the sync and deferred maps kept their entry for the same key, so the wire carried two contradictory values. The later loader now drops any stale entry from the opposite map.
- **`furin-env.d.ts` entries are now sorted deterministically** — generated route manifest entries are sorted by pattern to prevent non-deterministic diffs across rebuilds.
- **String HTTP status handling** — the router now correctly normalizes string status codes (e.g. `"404"`) to numbers before rendering error boundaries.
- **`react-doctor` diff base branch** — corrected the base branch reference for `react-doctor` automated review diffs.
- **Registry and runtime fixes** — PR review fixes across the route registry, runtime error handling, and test suite stability.

## [0.1.0-alpha.14] — 2026-05-24

### Added
- **`defer()` and `<Await>`** — Streaming loader data with deferred promises. Loaders can return `defer({ slow: slowPromise })` and the page renders immediately with a fallback. `<Await resolve={slow} fallback={<Loading />}>` unwraps the promise when it resolves. Uses NDJSON streaming for SSR/ISR with automatic client-side hydration of deferred chunks.
- `useAsyncError()` and `useAsyncValue()` hooks for reading deferred promise states inside `<Await>` error boundaries and children.
- **Deferred SSR chunks now stream in settle order** — `renderSSR` emitted deferred resolution `<script>`s in loader-declaration order, so a fast field was held hostage by a slow sibling. Chunks are now flushed as each Promise settles.
- **SPA navigation title comes from `head()`** — the `/_furin/data` endpoint now resolves the page title server-side and ships it as `__furinTitle`. A loader returning a plain `title` field no longer hijacks `document.title`; `head()` is the single source of truth.

### Fixed
- **`defer()` brand no longer leaks into props** — the internal `__isDeferred` marker was surfacing as a typed component / `head()` prop. It is now stripped from the inferred loader-data type.
- **Parent-deferred fields are now typed as `Promise<T>` for descendants** — `PromisifyData<T>` previously double-wrapped a parent loader's deferred field into `Promise<Promise<T>>`, forcing callers into a redundant `await await ctx.field`. The type now mirrors the existing JS Promise-chaining auto-flatten so a single `await` is sufficient — simplified to `Promise<Awaited<T[K]>>`. No runtime change.
- `rebuildDevRoute` now recomputes route mode (SSR/SSG/ISR) on every dev request after HMR re-import, so toggling `revalidate` or adding/removing a loader takes effect immediately without a server restart.
- Loaders that throw a `Response` (e.g. redirect) now correctly trigger the error boundary instead of silently failing during SPA navigation.
- `evlog` path logging, DCE transform `JSXIdentifier` handling, static SPA navigation edge case, and test flakiness.

## [0.1.0-alpha.13] — 2026-05-03

### Added
- Scaffolder build process now uses the `yuku` parser instead of `oxc-parser` for faster server/build scanning and template transformation.

### Fixed
- `scan-server` now correctly detects `.d.ts` files, pre-transpiles TS/TSX with `Bun.Transpiler` before parsing, and surfaces the first actual error diagnostic instead of treating warnings as errors.
- `transform-client` no longer logs warnings as errors when using `deadCodeElimination` or `transformForClient`.
- `<Link>` active-state comparison now normalizes both sides with `normalizeHref` and skips `isActive` for absolute URLs.
- `normalizeHref` is now applied to SSR `currentHref` assignments, preventing hydration mismatches between server and client.
- Build process now emits `dist/internal.js` and `dist/runtime-env.js` as standalone bundles so compile-entry imports succeed at runtime.
- Build process now ensures `dist/render` and `dist/build` directories exist via `mkdirSync` before copying, removing a fragile implicit dependency on tsc `.d.ts` emission order.
- Windows path normalization in build entry template so `endsWith` checks and module paths work correctly on Windows.
- `.d.ts` files are now skipped entirely during server scanning instead of being misclassified as JavaScript.

## [0.1.0-alpha.12] — 2026-05-03

### Fixed
- Trailing-slash regex in generated hydration entry now strips multiple consecutive trailing slashes (`///`) instead of just one.
- `MdxLink` wrapper in docs app now correctly treats relative MDX links as internal and enforces `rel="noopener noreferrer"` on external anchors.
- `revalidatePath` signature restored to accept a single argument (default `"page"`) for backward compatibility.
- `<Link>` now handles absolute URLs correctly and prevents navigation on disabled links.
- `shouldInterceptClick` test helpers no longer rely on implicit default parameters.
- Cache invalidator registration is now re-registered after `__resetCacheState()` and `__resetDevLoaderCacheState()` to prevent cache leaks in test environments.

### Changed
- Router provider extracted into its own module (`refactor: extract router provider`).
- Unified cache invalidation logic — root path is always included in CDN purge set alongside descendant paths.
- `RouterProvider` props (`autoRefresh`, `basePath`, `defaultPreload`, `defaultPreloadDelay`, `defaultPreloadStaleTime`, `prefetchCacheSize`) are now required instead of optional.

## [0.1.0-alpha.11] — 2026-04-30

### Added
- **Dev cache invalidation for SSG and ISR routes** — `revalidatePath()` now also clears the dev-mode loader data caches, so mutations immediately reflect in the browser without waiting for the revalidate window.
- **ISR support in dev mode** — dev server now caches ISR loader data with proper freshness tracking, matching production behaviour.
- **Dev invalidator watches nested `pages/` directories** — source-file mtime tracking now covers all nested layout and page files, preventing stale data after edits in deeply nested routes.

### Fixed
- ISR HMR loader not serving fresh data after a loader-bearing route was hot-reloaded.
- ISR cache key collision between routes with identical URL paths but different root directories.
- Various review fixes from automated and human code review (trailing-slash normalization, click interception, MDX link security).

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

[Unreleased]: https://github.com/teyik0/furin/compare/c228ea2...HEAD
[0.2.0-alpha.4]: https://github.com/teyik0/furin/compare/v0.2.0-alpha.3...c228ea2
[0.2.0-alpha.3]: https://github.com/teyik0/furin/compare/v0.2.0-alpha.2...v0.2.0-alpha.3
[0.2.0-alpha.2]: https://github.com/teyik0/furin/compare/v0.2.0-alpha.1...v0.2.0-alpha.2
[0.2.0-alpha.1]: https://github.com/teyik0/furin/compare/v0.1.0-alpha.15...v0.2.0-alpha.1
[0.1.0-alpha.15]: https://github.com/teyik0/furin/compare/v0.1.0-alpha.14...v0.1.0-alpha.15
[0.1.0-alpha.14]: https://github.com/teyik0/furin/compare/v0.1.0-alpha.13...v0.1.0-alpha.14
[0.1.0-alpha.13]: https://github.com/teyik0/furin/compare/v0.1.0-alpha.12...v0.1.0-alpha.13
[0.1.0-alpha.12]: https://github.com/teyik0/furin/compare/v0.1.0-alpha.11...v0.1.0-alpha.12
[0.1.0-alpha.11]: https://github.com/teyik0/furin/compare/v0.1.0-alpha.10...v0.1.0-alpha.11
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

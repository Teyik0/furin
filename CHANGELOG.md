# Changelog

All notable changes to Furin will be documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

[Unreleased]: https://github.com/teyik0/furin/compare/v0.1.0-alpha.8...HEAD
[0.1.0-alpha.8]: https://github.com/teyik0/furin/compare/v0.1.0-alpha.7...v0.1.0-alpha.8
[0.1.0-alpha.7]: https://github.com/teyik0/furin/compare/v0.1.0-alpha.6...v0.1.0-alpha.7
[0.1.0-alpha.6]: https://github.com/teyik0/furin/compare/v0.1.0-alpha.5...v0.1.0-alpha.6
[0.1.0-alpha.5]: https://github.com/teyik0/furin/compare/v0.1.0-alpha.4...v0.1.0-alpha.5
[0.1.0-alpha.4]: https://github.com/teyik0/furin/compare/v0.1.0-alpha.3...v0.1.0-alpha.4
[0.1.0-alpha.3]: https://github.com/teyik0/furin/compare/v0.1.0-alpha.2...v0.1.0-alpha.3
[0.1.0-alpha.2]: https://github.com/teyik0/furin/compare/v0.1.0-alpha.1...v0.1.0-alpha.2
[0.1.0-alpha.1]: https://github.com/teyik0/furin/releases/tag/v0.1.0-alpha.1

# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**Elysion** is a React meta-framework powered by [Elysia](https://elysiajs.com/). It provides file-based routing with SSR, SSG, and ISR rendering modes, similar to Next.js but built on Elysia + Bun.

## Commands

- `bun run dev` — Run the example app with watch mode
- `bun run build` — Build the library to `dist/`
- `bun run check` — Lint with ultracite (biome-based)
- `bun run fix` — Auto-fix lint issues
- `bun run tsc` — Type-check without emitting
- `bun test` — Run tests

## Tooling

- **Runtime**: Bun only. Never use Node.js, npm, yarn, pnpm, dotenv, express, vite, or webpack.
- **Linting**: Ultracite (wraps Biome). Config in `biome.jsonc`.
- **CSS**: Tailwind v4 via `bun-plugin-tailwind` (configured in `bunfig.toml`).
- **Path alias**: `"elysion"` maps to `./src/index.ts` (see `tsconfig.json` paths).

## Architecture

The framework lives in `src/` and an example app lives in `example/`.

### Core (`src/`)

- **`index.ts`** — Main entrypoint. Exports `elysion()` which scans pages, creates route plugins, mounts static file serving via `@elysiajs/static`, and starts the Elysia server. Also re-exports `page` from `page.ts`.
- **`page.ts`** — Defines the `page(component, options?)` function that page files must use as their default export. Options include `loader`, `head`, `action`, `mode` (ssr/ssg/isr), and `revalidate`. The `PageModule` type is branded with `__brand: "elysion-react-page"`.
- **`router.ts`** — File-based router. `scanPages()` globs `**/*.tsx` in the pages directory, imports each, and resolves routes. `createRoutePlugin()` creates an Elysia plugin per route with GET (and optionally POST for actions) handlers. Contains rendering logic for SSR/SSG/ISR modes with caching.
- **`render.ts`** — (WIP) Server-side React rendering utilities.

### Rendering Modes

Mode resolution in `router.ts` (`resolveMode`):
- No loader → **SSG** (static generation)
- Has loader → **SSR** (server-side rendering)
- Has `revalidate > 0` → **ISR** (incremental static regeneration)
- Explicit `mode` option always wins

### File-based Routing Conventions

Pages go in a `pages/` directory (configurable via `pagesDir`):
- `index.tsx` → `/`
- `about.tsx` → `/about`
- `blog/index.tsx` → `/blog`
- `blog/[slug].tsx` → `/blog/:slug`
- `[...catch].tsx` → `/*` (catch-all)
- `_hidden.tsx` → ignored (underscore prefix)

### Example App (`example/`)

- `example/src/server.ts` — Creates an Elysia app, uses `elysion()` plugin, adds API routes under `/api`
- `example/src/pages/` — Page components using `page()` export convention
- `example/public/` — Static assets served at `/public`

### Page File Convention

Every page must default-export the result of `page(props)`:

```ts
// Abstraction using page function in our framework
interface PageOptions<
  TData extends Record<string, unknown>,
  TQuery extends AnySchema | undefined = undefined,
  TParams extends AnySchema | undefined = undefined,
> {
  params?: TParams extends AnySchema ? UnwrapSchema<TParams> : Record<string, string>;
  query?: TQuery;
  loader?: (ctx: LoaderContext<TQuery, TParams>) => Promise<TData> | TData;
  head?: (ctx: HeadContext<TParams, TData>) => HeadOptions;
  component: React.FC<TData>;
  mode?: "ssr" | "ssg" | "isr";
  revalidate?: number | false;
}

export function page<
  TData extends Record<string, unknown>,
  TQuery extends AnySchema | undefined = undefined,
  TParams extends AnySchema | undefined = undefined,
  TActionBody extends AnySchema | undefined = undefined,
>(props: PageOptions<TData, TQuery, TParams, TActionBody>) {
  return {
    __brand: "ELYSION_REACT_PAGE",
    ...props
  };
}

// This will create this behind the scene
new Eylisa()
  // If param is not set
  .guard({ query: queryModel })
  .resolve(async (ctx) => await loaderFunction())
  .get(routePath, async ({ query, loaderData }) => render(ReactComponent(loaderData), { mode, revalidate }))
  // If param is set
  .guard({ query: queryModel, params: paramsModel })
  .resolve(async (ctx) => await loaderFunction())
  .get(`${routePath}/:params`, async ({ params, loaderData }) => render(ReactComponent(loaderData), { mode, revalidate }))

// This generated code will be appended under the hood to the elysion plugin
const app = new Elysia()
  .use(authPlugin)
  .use(
    await elysion({
      pagesDir: `${import.meta.dir}/pages`,
      staticOptions: {
        assets: `${import.meta.dir}/../public`,
        prefix: "/public",
        staticLimit: 1024,
        alwaysStatic: process.env.NODE_ENV === "production",
      },
    })
  )
```

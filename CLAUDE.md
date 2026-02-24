# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**Elysion** is a React meta-framework powered by [Elysia](https://elysiajs.com/). It provides file-based routing with SSR, SSG, and ISR rendering modes, nested layouts, HMR with React Fast Refresh, and full TypeScript type inference — similar to Next.js but built on Elysia + Bun.

## Commands

- `bun run dev` — Run the example app with HMR
- `bun run fix` — Auto-fix lint issues
- `bun run test` — Run tests
- `bun run build` — Build the library to `dist/`
- `bun run test:types` — Type-check without emitting

## Guidelin

- Always use the git hook when commit/push
- Never commit/push using --no-verify

## Tooling

- **Runtime**: Bun only. Never use Node.js, npm, yarn, pnpm, dotenv, express, vite, or webpack.
- **Linting**: Ultracite (wraps Biome). Config in `biome.jsonc`.
- **CSS**: Tailwind v4 via `bun-plugin-tailwind` (configured in `bunfig.toml`).
- **Path alias**: `"elysion"` maps to `./packages/core/src/elysion.ts` (see `tsconfig.json` paths).

## Architecture

Monorepo structure with framework in `packages/core/` and example app in `examples/simple/`.

### Core (`packages/core/src/`)

| File | Purpose |
|------|---------|
| `elysion.ts` | Main plugin. Exports `elysion()` which scans pages, builds client, creates route plugins, mounts static serving. |
| `client.ts` | Client-side types. Exports `createRoute()`, `RouteRef`, `Route`, `RuntimePage`, `RuntimeRoute`, `HeadOptions`, `InferProps`. |
| `router.ts` | File-based router. `scanPages()` globs `**/*.tsx` in pages directory, resolves routes, `createRoutePlugin()` creates Elysia plugin per route. |
| `render.tsx` | SSR/SSG/ISR rendering logic. `buildElement()` wraps component in layout chain. Executes loaders, handles caching. |
| `shell.tsx` | HTML template with head management, `__ELYSION_DATA__` hydration payload, script tags. |
| `build.ts` | Client bundle generation via `Bun.build()`. Generates hydrate entry, includes React Refresh in dev. |
| `types.ts` | Runtime type guards: `isElysionPage()`, `isElysionRoute()`, `collectRouteChain()`. |

### HMR (`packages/core/src/hmr/`)

| File | Purpose |
|------|---------|
| `plugin.ts` | Elysia plugin for HMR. WebSocket endpoint `/__elysion/hmr`, module serving `/_modules/pages/*`, client bundle `/__elysion/client.js`. |
| `watcher.ts` | File watcher with `fs.watch`. Debounces events, invalidates module cache, increments version for SSR, broadcasts via WebSocket. |
| `transform.ts` | Babel transform for React Fast Refresh. TypeScript → JSX → React Refresh, extracts component from `page()` calls. |
| `refresh-setup.ts` | DevTools hook setup script. Creates `__REACT_DEVTOOLS_GLOBAL_HOOK__` before React DOM loads. |

### Example App (`examples/simple/`)

```
examples/simple/
├── src/
│   ├── server.ts         # Elysia app with auth plugin + elysion()
│   └── pages/            # File-based routes
│       ├── index.tsx         # SSG page
│       ├── dashboard.tsx     # SSR page with query params
│       ├── admin.tsx         # SSR page with loader
│       ├── login.tsx         # SSG page
│       └── [blog]/index.tsx  # Dynamic route
└── public/
```

## Exports

### `"elysion"` (main)

```ts
import { elysion } from "elysion";
```

- `elysion(options)` — Main plugin function

### `"elysion/client"`

```ts
import { createRoute, type InferProps, type HeadOptions } from "elysion/client";
```

- `createRoute(config)` — Create a route with loader, layout, params, query
- `RouteRef<TData, TParams, TQuery>` — Branded type for parent references
- `Route<TData, TParams, TQuery>` — Route interface
- `RuntimePage`, `RuntimeRoute` — Runtime types
- `HeadOptions` — Head metadata type
- `InferProps<T>` — Extract props from route/page

## API

### createRoute

```tsx
import { createRoute } from "elysion/client";
import { t } from "elysia";

const route = createRoute({
  parent?: parentRoute,           // For nested layouts
  mode?: "ssr" | "ssg" | "isr",   // Rendering mode
  revalidate?: number,            // ISR interval (seconds)
  params?: t.Object({...}),       // Elysia schema for params
  query?: t.Object({...}),        // Elysia schema for query
  loader?: async (ctx) => {...},  // Data fetching
  layout?: (props) => <Layout>{children}</Layout>,
});

// For simple routes without layouts:
const { page } = createRoute({ mode: "ssg" });
```

### route.page

```tsx
export default route.page({
  head?: (ctx) => ({ meta: [...], links: [...], scripts: [...] }),
  loader?: async (ctx) => {...},  // Page-level loader
  component: (props) => <Page />,
});
```

## Rendering Modes

Mode resolution in `router.ts` (`resolveMode`):

| Condition | Mode |
|-----------|------|
| Explicit `mode` option | Always wins |
| No loader | **SSG** (static generation) |
| Has loader + `revalidate > 0` | **ISR** (incremental static regeneration) |
| Has loader, no revalidate | **SSR** (server-side rendering) |

## File-based Routing

Pages go in a `pages/` directory (configurable via `pagesDir`):

| File | Route |
|------|-------|
| `index.tsx` | `/` |
| `about.tsx` | `/about` |
| `blog/index.tsx` | `/blog` |
| `blog/[slug].tsx` | `/blog/:slug` |
| `[...catch].tsx` | `/*` (catch-all) |
| `_hidden.tsx` | ignored (underscore prefix) |

### Layouts

Use `route.tsx` files for layouts:

```
pages/
  route.tsx              # Root layout
  index.tsx              # Home page
  dashboard/
    route.tsx            # Dashboard layout
    index.tsx            # /dashboard
    users/
      route.tsx          # Users layout
      index.tsx          # /dashboard/users
```

### Data Flow

Parent data flows flat (like Elysia's `resolve`):

```tsx
// pages/dashboard/route.tsx
export const route = createRoute({
  loader: async () => ({ user: await getCurrentUser() }),
  layout: ({ children, user }) => <Shell user={user}>{children}</Shell>,
});

// pages/dashboard/users/route.tsx
import { route as dashboardRoute } from "../route";

export const route = createRoute({
  parent: dashboardRoute,
  loader: async ({ user }) => ({ users: await getUsers(user.orgId) }),
  // user is available here (flat, not nested)
});

// pages/dashboard/users/index.tsx
export default route.page({
  component: ({ user, users }) => (
    // Both user and users available (flat)
    <div>{user.name}: {users.length} users</div>
  ),
});
```

## HMR Architecture

1. **File Watcher** (`hmr/watcher.ts`) — Watches pages directory, broadcasts changes via WebSocket
2. **WebSocket** (`hmr/plugin.ts`) — `/__elysion/hmr` endpoint, sends update messages to clients
3. **Module Transform** (`hmr/transform.ts`) — Babel pipeline with React Refresh
4. **Client Bundle** (`build.ts`) — Includes HMR client with auto-reconnect
5. **DevTools Setup** (`hmr/refresh-setup.ts`) — Creates React DevTools hook

Key: Module IDs must be consistent between hydration and HMR updates (`/_modules/pages/<path>`).

## Type Inference

Full type safety without codegen:

```tsx
const route = createRoute({
  params: t.Object({ slug: t.String() }),
  loader: async ({ params }) => ({
    post: await getPost(params.slug),  // params.slug: string
  }),
});

export default route.page({
  loader: async ({ post }) => ({
    comments: await getComments(post.id),  // post is typed
  }),
  component: ({ post, comments, params }) => (
    // All props fully typed
    <article>{post.title}</article>
  ),
});
```

Use `InferProps` for external components:

```tsx
function MyLayout(props: InferProps<typeof route>) {
  // props.post, props.params, props.children all typed
}
```

## import.meta.hot usage

For this to work, Bun forces these APIs to be called without indirection. That means the following do not work:
From the doc https://bun.com/docs/bundler/hot-reloading.md

```ts
// INVALID: Assigning `hot` to a variable
const hot = import.meta.hot;
hot.accept();

// INVALID: Assigning `import.meta` to a variable
const meta = import.meta;
meta.hot.accept();
console.log(meta.hot.data);

// INVALID: Passing to a function
doSomething(import.meta.hot.dispose);

// OK: The full phrase "import.meta.hot.<API>" must be called directly:
import.meta.hot.accept();

// OK: `data` can be passed to functions:
doSomething(import.meta.hot.data);
```

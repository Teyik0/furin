# Furin

React meta-framework powered by Elysia and Bun, with file-based routing, nested layouts, SSR, SSG, ISR, and full TypeScript inference.

## Features

- file-based routing from `src/pages`
- nested layouts with `_route.tsx`
- SSR, SSG, and ISR through `createRoute()`
- typed `params`, `query`, loader data, and `<Link />` search objects
- one process for API routes and frontend pages
- Bun-native development flow with Fast Refresh

## Quick Start

```bash
bun create furin@latest my-app
cd my-app
bun install
bun run dev
```

For the shadcn/ui starter:

```bash
bun create furin@latest my-app --template full
```

## First App

```tsx
// src/pages/root.tsx
import { createRoute } from "@teyik0/furin/client";

export const route = createRoute({
  layout: ({ children }) => (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta content="width=device-width, initial-scale=1" name="viewport" />
      </head>
      <body>{children}</body>
    </html>
  ),
});
```

```tsx
// src/pages/index.tsx
import { route } from "./root";

export default route.page({
  component: () => <h1>Hello Furin</h1>,
});
```

```ts
// src/server.ts
import { Elysia } from "elysia";
import { furin } from "@teyik0/furin";

const app = new Elysia()
  .use(await furin({ pagesDir: "./src/pages" }))
  .listen(3000);

export type App = typeof app;
```

## Route API

Use `createRoute()` for route-level configuration:

- `parent`
- `mode`
- `revalidate`
- `params`
- `query`
- `loader`
- `layout`

Use `route.page()` for page-level configuration:

- `component`
- `loader`
- `head`
- `staticParams`

## Example: Nested Layout + Typed Data

```tsx
// src/pages/dashboard/_route.tsx
import { createRoute } from "@teyik0/furin/client";
import { route as rootRoute } from "../root";

export const route = createRoute({
  parent: rootRoute,
  loader: async ({ request }) => {
    const user = await getSession(request);
    return { user };
  },
  layout: ({ children, user }) => (
    <div>
      <DashboardNav user={user} />
      {children}
    </div>
  ),
});
```

```tsx
// src/pages/dashboard/index.tsx
import { route } from "./_route";

export default route.page({
  loader: async ({ user }) => {
    const stats = await getDashboardStats(user.id);
    return { stats };
  },
  component: ({ stats, user }) => <Dashboard user={user} stats={stats} />,
});
```

## Rendering Modes

Rendering mode belongs to `createRoute()`:

```tsx
import { createRoute } from "@teyik0/furin/client";

const route = createRoute({
  mode: "ssg",
});

export default route.page({
  component: () => <div>Static page</div>,
});
```

ISR uses `revalidate` on the route:

```tsx
const route = createRoute({
  mode: "isr",
  revalidate: 60,
});
```

Dynamic SSG pages enumerate paths with `staticParams()` on `route.page()`:

```tsx
export default route.page({
  staticParams: async () => {
    const slugs = await getSlugs();
    return slugs.map((slug) => ({ slug }));
  },
  component: ({ post }) => <Post post={post} />,
});
```

## File-Based Routing

```text
src/pages/
├── root.tsx
├── index.tsx
├── blog/
│   ├── _route.tsx
│   ├── index.tsx
│   └── [slug].tsx
└── docs/
    ├── _route.tsx
    └── [...path].tsx
```

- pages are regular `.tsx` files
- `_route.tsx` files define layouts and route-level config
- dynamic params use `[slug]`
- catch-all routes use `[...path]`

## Typed Navigation

Furin generates `furin-env.d.ts` so `@teyik0/furin/link` can type valid paths and route search params.

```tsx
import { Link } from "@teyik0/furin/link";

<Link to="/docs/rendering">Rendering</Link>;
```

When a route declares a `query` schema, `<Link search={...} />` is typed from that schema.

## API Routes

Elysia routes live alongside Furin pages in the same server:

```ts
import { Elysia } from "elysia";
import { furin } from "@teyik0/furin";
import { api } from "./api";

const app = new Elysia()
  .use(api)
  .use(await furin({ pagesDir: "./src/pages" }))
  .listen(3000);
```

## Build And Deployment

Today, the implemented production build target is Bun.

```bash
bunx furin build --target bun
```

Output is written under:

```text
.furin/build/bun/
```

Compile modes:

- `--compile server` keeps built client assets on disk next to the binary
- `--compile embed` embeds the client assets into the binary and removes the built client directory from the target output

The config type mentions `node`, `vercel`, and `cloudflare`, but those targets are planned and not implemented in the current build path.

## Workspace Commands

From this monorepo root:

```bash
bun run fix
bun run test
bun run test:types
```

For the docs app:

```bash
cd apps/docs
bun run dev
```

## Reference

- docs site: `apps/docs`
- example apps: `examples/task-manager`, `examples/weather`
- core package: `packages/core`

For the full docs experience, read the site in `apps/docs`.

# Elysion

A React meta-framework powered by [Elysia](https://elysiajs.com/) and [Bun](https://bun.sh). File-based routing with SSR, SSG, and ISR support.

## Quick Start

```bash
bun install
bun run dev
```

The example app runs at `http://localhost:3000`.

## Usage

### Server Setup

```ts
import { Elysia } from "elysia";
import { elysion } from "elysion";

const app = new Elysia()
  .use(
    elysion({
      pagesDir: `${import.meta.dir}/pages`,
      staticOptions: {
        assets: `${import.meta.dir}/../public`,
        prefix: "/public",
      },
    })
  )
  .group("/api", (api) =>
    api.get("/health", () => ({ status: "ok" }))
  )
  .listen(3000);
```

`elysion()` scans the pages directory, registers routes as Elysia plugins, and sets up static file serving.

### Pages

Every page file must default-export the result of `page()`:

```tsx
import { page } from "elysion";

export default page(MyComponent, {
  mode: "ssr",           // "ssr" | "ssg" | "isr"
  loader: async () => {}, // server-side data fetching
  action: async () => {}, // form POST handler
  head: () => {},         // <head> metadata
  revalidate: 60,         // ISR revalidation interval (seconds)
});
```

### File-based Routing

Pages go in a `pages/` directory:

| File | Route |
|---|---|
| `index.tsx` | `/` |
| `about.tsx` | `/about` |
| `blog/index.tsx` | `/blog` |
| `blog/[slug].tsx` | `/blog/:slug` |
| `[...catch].tsx` | `/*` |
| `_hidden.tsx` | ignored |

### Rendering Modes

The rendering mode is resolved automatically based on page options:

| Condition | Mode |
|---|---|
| No `loader` | **SSG** — static generation |
| Has `loader` | **SSR** — server-side rendering |
| Has `revalidate > 0` | **ISR** — incremental static regeneration |
| Explicit `mode` option | Always wins |

## Development

```bash
bun run dev       # Run example with watch mode
bun run build     # Build library to dist/
bun run check     # Lint (ultracite/biome)
bun run fix       # Auto-fix lint issues
bun run tsc       # Type-check
bun test          # Run tests
```

## Tech Stack

- **Runtime**: [Bun](https://bun.sh)
- **Server**: [Elysia](https://elysiajs.com/)
- **UI**: [React 19](https://react.dev/)
- **CSS**: [Tailwind v4](https://tailwindcss.com/)
- **Linting**: [Ultracite](https://github.com/haydenbleasel/ultracite) (Biome)

## Page function

**Order**: resolve (loader) → beforeHandle → GET/POST (handler) → afterHandle

```ts
// Abstraction using page function in our framework
export default page(Component, {
  // Validation (using Elysia guard)
  query: queryModel,
  params: paramsModel,
  // GET - simple data fetching, forward data to the Component
  loader: async ({ query, params }) => {
    return await loaderFunction();
  },
  beforeHandle: async (ctx) => await beforeFunction(),  
  afterHandle: async (ctx) => await afterFunction(),
  
  // POST - Separate mutation
  action: {
    body: actionModel,
    handler: async ({ body }) => {
      return await actionFunction(body);
    }
  },
  
  mode: "ssr",
  revalidate: 60,
})

// This will create this behind the scene
new Eylisa()
  // If param is not set
  .guard({ query: queryModel })
  .resolve(async (ctx) => await loaderFunction())
  .get(routePath, async ({ query }) => Component)
  .post(routePath, async ({ body }) => await actionFunction(actionModel)) 
  // If param is set
  .guard({ query: queryModel, params: paramsModel })
  .resolve(async (ctx) => await loaderFunction())
  .get(`${routePath}/:params`, async ({ params }) => await productService.getById(params))
  .post(`${routePath}/:params`, async ({ body }) => await actionFunction(actionModel), {
  	body: actionModel,
  })
```

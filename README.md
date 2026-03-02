# Elyra

Web meta-framework as a plugin powered by Elysia with file-based routing, SSR/SSG/ISR modes, and full TypeScript type inference. No vite, one process, backend and frontend at the same place.

## Features

- 🚀 **File-based routing** with dynamic segments and catch-all routes
- ⚡ **SSR/SSG/ISR** rendering modes with automatic resolution
- 🔒 **Type-safe** params, query, and loader data (zero codegen)
- 🎨 **Nested layouts** with automatic data propagation
- 🔄 **Hot Module Replacement** with Bun HMR
- 🌐 **API routes** via Elysia
- 🎯 **Zero-config** TypeScript support

## Quick Start

### Installation

```bash
bun create elyra my-app
cd my-app
bun install
```

### Create Your First Page

```tsx
// src/pages/about/index.tsx
import { createRoute } from 'elyra/client';

const { page } = createRoute({ mode: 'ssg' });

export default page({
  component: () => (
    <div>
      <h1>About Us</h1>
      <p>A React meta-framework powered by Elysia + Bun</p>
    </div>
  ),
});
```

## Core Concepts

### Routes with Loaders

Fetch data server-side with full type safety:

```tsx
// src/pages/dashboard/route.tsx
import { createRoute } from 'elyra/client';
import { t } from "elysia";

export const route = createRoute({
  query: t.Object({
    visits: t.Optional(t.Number()),
  }),
  loader: async ({ query }) => {
    // query.visits is typed as number | undefined ✓
    return {
      user: { name: "John Doe", email: "john@example.com" },
      stats: { visits: query.visits || 0, lastLogin: new Date() }
    };
  },
});

// src/pages/dashboard/index.tsx
import { route } from './route';

export default route.page({
  component: ({ user, stats }) => {
    return (
      <div>
        <h1>Welcome {user.name}</h1>
        <p>Visits: {stats.visits}</p>
        <p>Last login: {stats.lastLogin.toLocaleDateString()}</p>
      </div>
    );
  },
});
```

### Type Inference Flow

```
createRoute({ parent, loader, layout })
  │
  │  parent data (flat, like Elysia resolve)
  │         ↓
  │  loader({ ...parentData, params, query }) → TLoaderData
  │         ↓
  │  layout({ ...parentData, ...loaderData, children, params, query })
  │         ↓
  └→ route.page({ loader, component, head })
           │
           │  all accumulated data, flat
           │         ↓
           │  loader({ ...allData, params, query }) → TPageData
           │         ↓
           │  component({ ...allData, ...pageData, params, query })
           │  head({ ...allData, ...pageData, params, query })
           ↓
       fully typed, zero codegen, zero explicit generics
```

### Nested Layouts

Create nested layouts with automatic data propagation:

```tsx
// src/pages/dashboard/route.tsx
import { createRoute } from 'elyra/client';

export const route = createRoute({
  loader: async () => ({ user: await getCurrentUser() }),

  layout: ({ children, user }) => (
    <DashboardShell user={user}>
      {children}
    </DashboardShell>
  )
});

// src/pages/dashboard/users/route.tsx
import { createRoute } from 'elyra/client';
import { route as dashboardRoute } from '../route';

export const route = createRoute({
  parent: dashboardRoute,

  loader: async ({ user }) => {
    // user is flat from dashboard route (like Elysia resolve)
    return {
      users: await getUsers(user.orgId),
      currentUser: user
    };
  },

  layout: ({ children, users, currentUser }) => (
    <UsersLayout users={users} currentUser={currentUser}>
      {children}
    </UsersLayout>
  )
});

// src/pages/dashboard/users/index.tsx
import { route } from './route';

export default route.page({
  loader: async ({ user, users }) => {
    // all data flat: user from dashboard, users from users route
    return {
      stats: await getUserStats(user.id)
    };
  },

  component: ({
    user,         // ← From dashboard route
    users,        // ← From users route
    currentUser,  // ← From users route
    stats,        // ← From page loader
  }) => (
    <div>
      <h1>Users ({users.length})</h1>
      <StatsCard stats={stats} />
    </div>
  )
});
```

### Full Example with All Features

```tsx
// src/pages/blog/[slug]/route.tsx
import { createRoute, type InferProps } from 'elyra/client';
import { t } from "elysia";

export const route = createRoute({
  mode: 'ssr',
  revalidate: 3600,

  params: t.Object({
    slug: t.String({ minLength: 3 })
  }),

  query: t.Object({
    search: t.Optional(t.String()),
    page: t.Optional(t.Number({ default: 1 }))
  }),

  loader: async ({ params, query }) => {
    return {
      post: await getPost(params.slug),
      related: await getRelated(params.slug)
    };
  },

  layout: (props) => <BlogLayout {...props} />
});

// Component with inferred props
function BlogLayout({ children, post, related, params, query }: InferProps<typeof route>) {
  return (
    <div>
      <BlogHeader post={post} />
      {children}
      <RelatedPosts posts={related} />
    </div>
  );
}

// src/pages/blog/[slug]/index.tsx
import { route } from './route';

export default route.page({
  head: ({ post }) => ({
    meta: [
      { title: post.title },
      { name: 'description', content: post.excerpt }
    ]
  }),

  loader: async ({ params, query, post }) => {
    // post, related are flat from route loader (like Elysia resolve)
    return {
      comments: await getComments(params.slug, query.page),
      isBookmarked: await checkBookmark(post.id)
    };
  },

  component: ({
    // From route loader
    post,
    related,
    // From page loader
    comments,
    isBookmarked,
    // Validated context
    params,
    query
  }) => (
    <article>
      <h1>{post.title}</h1>
      <PostContent content={post.content} />
      <CommentsList comments={comments} />
      <RelatedPosts posts={related} />
    </article>
  )
});
```

## Rendering Modes

### SSR (Server-Side Rendering)

Default mode when you have a loader. Renders on every request.

```tsx
// src/pages/dashboard/route.tsx
export const route = createRoute({
  mode: "ssr",  // or omit - SSR is default with loader
  loader: async () => {
    const data = await fetch("https://api.example.com/data");
    return { data };
  },
});

// src/pages/dashboard/index.tsx
import { route } from './route';

export default route.page({ component: MyPage });
```

### SSG (Static Site Generation)

Pre-render at build time. Perfect for content that doesn't change often.

```tsx
// src/pages/about/route.tsx
const { page } = createRoute({ mode: "ssg" });

// src/pages/about/index.tsx
export default page({
  component: () => <div>This page is static!</div>,
});
```

### ISR (Incremental Static Regeneration)

Static generation with periodic revalidation in the background.

```tsx
// src/pages/blog/route.tsx
export const route = createRoute({
  mode: 'ssr',
  revalidate: 60,  // Revalidate every 60 seconds
  loader: async () => {
    const posts = await fetchPosts();
    return { posts };
  },
});

// src/pages/blog/index.tsx
import { route } from './route';

export default route.page({
  component: ({ posts }) => <BlogPage posts={posts} />,
});
```

## File-Based Routing

Automatic routing based on file structure:

```
pages/
  route.tsx              # Layout and route config
  index.tsx              # → /
  about/
    route.tsx            # Layout for /about
    index.tsx            # → /about
  blog/
    route.tsx            # Layout for /blog
    index.tsx            # → /blog
    [slug]/
      route.tsx          # Layout for /blog/:slug
      index.tsx          # → /blog/:slug
  users/
    route.tsx            # Layout for /users
    [id]/
      route.tsx          # Layout for /users/:id
      settings.tsx       # → /users/:id/settings
  [...catch]/
    route.tsx            # Layout for catch-all
    index.tsx            # → /* (catch-all)
  _private.tsx           # ignored (underscore prefix)
```

### Dynamic Routes

#### Single Dynamic Segment

```tsx
// src/pages/blog/[slug]/route.tsx
import { createRoute } from 'elyra/client';
import { t } from "elysia";

export const route = createRoute({
  params: t.Object({
    slug: t.String(),
  }),
  loader: async ({ params: { slug } }) => {
    // slug is typed as string ✓
    const post = await fetchPost(slug);
    return { post };
  },
});

// src/pages/blog/[slug]/index.tsx
import { route } from './route';

export default route.page({
  component: ({ post }) => {
    return (
      <article>
        <h1>{post.title}</h1>
        <p>{post.content}</p>
      </article>
    );
  },
});
```

#### Catch-All Routes

```tsx
// src/pages/docs/[...path]/route.tsx
export const route = createRoute({
  params: t.Object({
    "*": t.String(),  // Catch-all uses "*"
  }),
  loader: async ({ params }) => {
    const segments = params["*"].split("/");
    const doc = await fetchDoc(segments);
    return { doc };
  },
});
```

## Type Safety

### Typed Query Parameters

```tsx
// src/pages/search/route.tsx
export const route = createRoute({
  query: t.Object({
    page: t.Number(),
    search: t.Optional(t.String()),
    filter: t.Array(t.String()),
  }),
  loader: ({ query }) => {
    // query.page: number ✓
    // query.search: string | undefined ✓
    // query.filter: string[] ✓
    return fetchResults({
      page: query.page,
      search: query.search,
      filters: query.filter,
    });
  },
});
```

### Typed URL Parameters

```tsx
// src/pages/users/[userId]/posts/[postId]/route.tsx
export const route = createRoute({
  params: t.Object({
    userId: t.String(),
    postId: t.String(),
  }),
  loader: ({ params }) => {
    // params.userId: string ✓
    // params.postId: string ✓
    return fetchUserPost(params.userId, params.postId);
  },
});
```

### InferProps Helper

Extract props type from a route or page for external components:

```tsx
// Component defined separately with full type safety
function MyComponent(props: InferProps<typeof route>) {
  // props is fully typed with all loader data, params, and query
  return <div>{props.post.title}</div>;
}

// Usage
export const route = createRoute({
  loader: async () => ({ post: { title: "Hello" } }),
  layout: (props) => <MyComponent {...props} />,
});
```

## API Reference

### `createRoute(config)`

Create a route with loader, layout, and options. Import from `"elyra/client"`.

**Config:**
- `parent?: Route` - Parent route for nested layouts
- `mode?: "ssr" | "ssg" | "isr"` - Rendering mode
- `revalidate?: number` - ISR revalidation interval (seconds)
- `params?: TSchema` - Elysia schema for URL parameters
- `query?: TSchema` - Elysia schema for query parameters
- `loader?: (ctx) => data` - Data fetching function (ctx has typed query/params/loader data from parent)
- `layout?: (props) => JSX` - React layout component (receives children, loader data, params, query)

**Returns:** `Route` - A route object with a `page()` method

### `route.page(config)`

Create a page for this route.

**Config:**
- `loader?: (ctx) => data` - Page-specific data fetching (receives all accumulated data from parent routes)
- `component: (props) => JSX` - React component (receives all accumulated data + page loader data)
- `head?: (ctx) => HeadOptions` - Head metadata function (SEO)

**Returns:** `Page` - A page module that can be exported as default

### `InferProps<T>`

Extract the props type from a route or page.

**Usage:**
```tsx
// For layouts (includes children)
function Layout(props: InferProps<typeof route>) {
  return <div>{props.children}</div>;
}

// For pages (no children)
function Component(props: InferProps<ReturnType<typeof route.page>>) {
  return <div>{props.post.title}</div>;
}

// Or more directly when page is directly available
function Component(props: InferProps<typeof page>>) {
  return <div>{props.post.title}</div>;
}
```

## Development

### Commands

```bash
bun run dev           # Development server with HMR
bun run build         # Build for production
bun run check         # Lint (ultracite/biome)
bun run fix           # Auto-fix lint issues
bun run tsc           # Type-check
bun test              # Run tests
```

### Project Structure

```
my-app/
├── packages/
│   └── core/              # Framework source
│       └── src/
│           ├── elyra.ts     # Main plugin
│           ├── client.ts      # createRoute, types
│           ├── router.ts      # File-based routing
│           ├── render.tsx     # SSR/SSG/ISR logic
│           ├── shell.tsx      # HTML template
│           ├── build.ts       # Client bundle
│           ├── types.ts       # Type guards
├── examples/
│   └── simple/            # Example app
│       ├── src/
│       │   ├── server.ts      # Elysia server entry
│       │   └── pages/         # File-based routes
│       └── public/            # Static assets
├── package.json
└── tsconfig.json
```

## Advanced

### Custom Server

```tsx
// src/server.ts
import { Elysia } from "elysia";
import { elyra } from "elyra";

const app = new Elysia()
  .get("/api/health", () => ({ status: "ok" }))
  .post("/api/users", async ({ body }) => {
    // Your API logic here
    return { success: true };
  })
  .use(
    await elyra({
      pagesDir: "./src/pages",
      staticOptions: {
        assets: "./public",
        prefix: "/",
      },
    })
  )
  .listen(3000);

console.log(`🦊 Server running at http://localhost:${app.server?.port}`);
```

## Contributing

Contributions are welcome! Please read [CONTRIBUTING.md](CONTRIBUTING.md) for details.

## License

MIT © Teyik0

## Credits

Built with:
- [Elysia](https://elysiajs.com/) - Fast and ergonomic web framework
- [Bun](https://bun.sh/) - All-in-one JavaScript runtime

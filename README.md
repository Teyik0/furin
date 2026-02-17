# Elysion

React meta-framework powered by Elysia + Bun with file-based routing, SSR/SSG/ISR modes, and full TypeScript type inference.

## Features

- 🚀 **File-based routing** with dynamic segments and catch-all routes
- ⚡ **SSR/SSG/ISR** rendering modes
- 🔒 **Type-safe** query params and loader data
- 🎯 **Zero-config** TypeScript support
- 🌐 **API routes** via Elysia
- 🔄 **Hot Module Replacement** in development
- 🎨 **Nested layouts** with automatic data propagation

## Quick Start

### Installation

```bash
bun create elysion my-app
cd my-app
bun install
```

### Create Your First Page

```typescript
// src/routes/about/index.tsx
import { createRoute } from 'elysion';

const route = createRoute({ mode: 'ssg' });

export default route.page({
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

```typescript
// src/routes/dashboard/route.tsx
import { createRoute } from 'elysion';
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

// src/routes/dashboard/index.tsx
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
           │  head({ data: allData & pageData, params, query })
           ↓
       fully typed, zero codegen, zero explicit generics
```

### Nested Layouts

Create nested layouts with automatic data propagation:

```typescript
// src/routes/dashboard/route.tsx
import { createRoute } from 'elysion';

export const route = createRoute({
  loader: async () => ({ user: await getCurrentUser() }),

  layout: ({ children, user }) => (
    <DashboardShell user={user}>
      {children}
    </DashboardShell>
  )
});

// src/routes/dashboard/users/route.tsx
import { createRoute } from 'elysion';
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

// src/routes/dashboard/users/index.tsx
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

```typescript
// src/routes/blog/route.tsx
import { createRoute, type InferProps } from 'elysion';
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

// src/routes/blog/index.tsx
import { route } from './route';

export default route.page({
  head: ({ post }) => ({
    title: post.title,
    meta: [
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

```typescript
// src/routes/dashboard/route.tsx
export const route = createRoute({
  mode: "ssr",  // or omit - SSR is default with loader
  loader: async () => {
    const data = await fetch("https://api.example.com/data");
    return { data };
  },
});

// src/routes/dashboard/index.tsx
export default route.page({ component: MyPage });
```

### SSG (Static Site Generation)

Pre-render at build time. Perfect for content that doesn't change often.

```typescript
// src/routes/about/route.tsx
export const route = createRoute({
  mode: "ssg",  // or omit loader - SSG is default without loader
});

// src/routes/about/index.tsx
export default route.page({
  component: () => <div>This page is static!</div>,
});
```

### ISR (Incremental Static Regeneration)

Static generation with periodic revalidation in the background.

```typescript
// src/routes/blog/route.tsx
export const route = createRoute({
  mode: 'ssr',
  revalidate: 60,  // Revalidate every 60 seconds
  loader: async () => {
    const posts = await fetchPosts();
    return { posts };
  },
});

// src/routes/blog/index.tsx
export default route.page({
  component: ({ posts }) => <BlogPage posts={posts} />,
});
```

## File-Based Routing

Automatic routing based on file structure:

```
routes/
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

```typescript
// src/routes/blog/[slug]/route.tsx
import { createRoute } from 'elysion';
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

// src/routes/blog/[slug]/index.tsx
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

```typescript
// src/routes/docs/[...path]/route.tsx
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

```typescript
// src/routes/search/route.tsx
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

```typescript
// src/routes/users/[userId]/posts/[postId]/route.tsx
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

```typescript
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

Create a route with loader, layout, and options.

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
```typescript
// For layouts (includes children)
function Layout(props: InferProps<typeof route>) {
  return <div>{props.children}</div>;
}

// For pages (no children)
function Component(props: InferProps<ReturnType<typeof route.page>>) {
  return <div>{props.post.title}</div>;
}
```

## Development

### Commands

```bash
bun run dev # Development server with watch mode
bun run tsc --noEmit # Type-check without emitting
bun run check # Lint with ultracite (biome)
bun run fix # Auto-fix lint issues
bun run build # Build for production
```

### Project Structure

```
my-app/
├── src/
│   ├── routes/              # File-based routes
│   │   ├── route.tsx        # Root layout
│   │   ├── index.tsx        # Home page
│   │   ├── about/
│   │   │   ├── route.tsx    # About layout
│   │   │   └── index.tsx    # About page
│   │   └── blog/
│   │       ├── route.tsx    # Blog layout
│   │       ├── index.tsx    # Blog list
│   │       └── [slug]/
│   │           ├── route.tsx # Post layout
│   │           └── index.tsx # Post page
│   ├── components/          # Shared React components
│   ├── lib/                 # Utility functions
│   └── server.ts            # Elysia server entry
├── public/                  # Static assets
├── package.json
└── tsconfig.json
```

## Advanced

### Custom Server

```typescript
// src/server.ts
import { Elysia } from "elysia";
import { elysion } from "elysion";

const app = new Elysia()
  .use(
    await elysion({
      pagesDir: "./src/routes",
      staticOptions: {
        assets: "./public",
        prefix: "/",
      },
    })
  )
  .get("/api/health", () => ({ status: "ok" }))
  .post("/api/users", async ({ body }) => {
    // Your API logic here
    return { success: true };
  })
  .listen(3000);

console.log(`🦊 Server running at http://localhost:${app.server?.port}`);
```

## Contributing

Contributions are welcome! Please read [CONTRIBUTING.md](CONTRIBUTING.md) for details.

## License

MIT © [Your Name]

## Credits

Built with:
- [Elysia](https://elysiajs.com/) - Fast and ergonomic web framework
- [Bun](https://bun.sh/) - All-in-one JavaScript runtime
- [React](https://react.dev/) - UI library
- [TypeBox](https://github.com/sinclairzx81/typebox) - JSON Schema type builder

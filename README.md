# Elysion

React meta-framework powered by Elysia + Bun with file-based routing, SSR/SSG/ISR modes, and full TypeScript type inference.

## Features

- 🚀 **File-based routing** with dynamic segments and catch-all routes
- ⚡ **SSR/SSG/ISR** rendering modes
- 🔒 **Type-safe** query params and loader data
- 🎯 **Zero-config** TypeScript support
- 🌐 **API routes** via Elysia
- 🔄 **Hot Module Replacement** in development

## Quick Start

### Installation

```bash
bun create elysion my-app
cd my-app
bun install
```

### Create Your First Page

```typescript
// src/pages/index.tsx
import { page } from "elysion/react";

export default page({
  component: () => (
    <div>
      <h1>Welcome to Elysion!</h1>
      <p>A React meta-framework powered by Elysia + Bun</p>
    </div>
  ),
});
```

## Core Concepts

### Pages with Loaders

Fetch data server-side with full type safety:

```typescript
// src/pages/dashboard.tsx
import { page, useLoaderData } from "elysion/react";
import { t } from "elysia";

export default page({
  query: t.Object({
    visits: t.Optional(t.Number()),
  }),
  loader: ({ query }) => {
    // query.visits is typed as number | undefined ✓
    return {
      user: { name: "John Doe", email: "john@example.com" },
      stats: { visits: query.visits, lastLogin: new Date() }
    };
  },
  component: Dashboard,
});

function Dashboard() {
  const { user, stats } = useLoaderData<{
    user: { name: string; email: string };
    stats: { visits: number | undefined; lastLogin: Date };
  }>();
  
  return (
    <div>
      <h1>Welcome {user.name}</h1>
      <p>Visits: {stats.visits}</p>
      <p>Last login: {stats.lastLogin.toLocaleDateString()}</p>
    </div>
  );
}
```

### Rendering Modes

#### SSR (Server-Side Rendering)

Default mode when you have a loader. Renders on every request.

```typescript
export default page({
  mode: "ssr",  // or omit - SSR is default with loader
  loader: async () => {
    const data = await fetch("https://api.example.com/data");
    return { data };
  },
  component: MyPage,
});
```

#### SSG (Static Site Generation)

Pre-render at build time. Perfect for content that doesn't change often.

```typescript
export default page({
  mode: "ssg",  // or omit loader - SSG is default without loader
  component: () => <div>This page is static!</div>,
});
```

#### ISR (Incremental Static Regeneration)

Static generation with periodic revalidation in the background.

```typescript
export default page({
  revalidate: 60,  // Revalidate every 60 seconds
  loader: async () => {
    const posts = await fetchPosts();
    return { posts };
  },
  component: BlogPage,
});
```

### Actions (POST Handlers)

Handle form submissions and mutations:

```typescript
export default page({
  loader: async () => ({
    users: await fetchUsers()
  }),
  action: {
    body: t.Object({
      name: t.String(),
      email: t.String(),
    }),
    handler: async ({ body }) => {
      // body.name and body.email are fully typed ✓
      const newUser = await createUser({
        name: body.name,
        email: body.email,
      });
      return { success: true, user: newUser };
    },
  },
  component: UsersPage,
});
```

### File-Based Routing

Automatic routing based on file structure:

```
pages/
  index.tsx           → /
  about.tsx           → /about
  blog/
    index.tsx         → /blog
    [slug].tsx        → /blog/:slug
  users/
    [id]/
      settings.tsx    → /users/:id/settings
  [...catch].tsx      → /* (catch-all)
  _private.tsx        → ignored (underscore prefix)
```

### Dynamic Routes

#### Single Dynamic Segment

```typescript
// pages/blog/[slug].tsx
import { page, useLoaderData } from "elysion/react";
import { t } from "elysia";

export default page({
  params: t.Object({
    slug: t.String(),
  }),
  loader: async ({ params }) => {
    // params.slug is typed as string ✓
    const post = await fetchPost(params.slug);
    return { post };
  },
  component: BlogPost,
});

function BlogPost() {
  const { post } = useLoaderData<{ post: Post }>();
  return (
    <article>
      <h1>{post.title}</h1>
      <p>{post.content}</p>
    </article>
  );
}
```

#### Catch-All Routes

```typescript
// pages/docs/[...path].tsx
export default page({
  params: t.Object({
    "*": t.String(),  // Catch-all uses "*"
  }),
  loader: async ({ params }) => {
    const segments = params["*"].split("/");
    const doc = await fetchDoc(segments);
    return { doc };
  },
  component: DocPage,
});
```

## Type Safety

### Typed Query Parameters

```typescript
export default page({
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
  component: SearchPage,
});
```

### Typed URL Parameters

```typescript
export default page({
  params: t.Object({
    userId: t.String(),
    postId: t.String(),
  }),
  loader: ({ params }) => {
    // params.userId: string ✓
    // params.postId: string ✓
    return fetchUserPost(params.userId, params.postId);
  },
  component: UserPostPage,
});
```

## API Reference

### `page(config)`

Create a page with loader, component, and options.

**Config:**
- `query?: TSchema` - Elysia schema for query parameters
- `params?: TSchema` - Elysia schema for URL parameters
- `loader?: (ctx) => data` - Data fetching function (ctx has typed query/params)
- `component: () => JSX` - React component
- `action?: { body, handler }` - POST handler
- `mode?: "ssr" | "ssg" | "isr"` - Rendering mode
- `revalidate?: number` - ISR revalidation interval (seconds)
- `head?: () => void` - Head metadata function

**Returns:** `PageModule` - A page module that can be exported as default

### `useLoaderData<T>()`

Hook to access loader data in components.

```typescript
function MyComponent() {
  const data = useLoaderData<{ user: User; posts: Post[] }>();
  return <div>{data.user.name}</div>;
}
```

**Type Parameter:**
- `T` - The shape of your loader data (optional, defaults to `Record<string, unknown>`)

**Returns:** The data returned by your page's loader function

**Throws:** Error if used outside a page component

## Development

### Commands

```bash
# Development server with watch mode
bun run dev

# Type-check without emitting
bun run tsc

# Lint with ultracite (biome)
bun run check

# Auto-fix lint issues
bun run fix

# Build for production
bun run build
```

### Project Structure

```
my-app/
├── src/
│   ├── pages/              # File-based routes
│   │   ├── index.tsx
│   │   ├── about.tsx
│   │   └── blog/
│   │       └── [slug].tsx
│   ├── components/         # Shared React components
│   ├── lib/                # Utility functions
│   └── server.ts           # Elysia server entry
├── public/                 # Static assets
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
      pagesDir: "./src/pages",
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

### Elysia Macros

Use Elysia's powerful macro system for authentication, authorization, etc:

```typescript
// In your Elysia server
app.macro(({ onBeforeHandle }) => ({
  isAuthenticated(enabled: boolean) {
    if (!enabled) return;
    
    onBeforeHandle(({ cookie }) => {
      if (!cookie.session) {
        return new Response("Unauthorized", { status: 401 });
      }
    });
  },
}));

// Use in your pages
export default page({
  // This page requires authentication via server macro
  loader: async () => {
    return { user: await getCurrentUser() };
  },
  component: ProtectedPage,
});
```

## Examples

Check out the `examples/` directory for:
- Simple blog with SSG
- Dashboard with SSR and authentication
- E-commerce with ISR
- API routes integration

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

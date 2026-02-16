## DX examples

### Full example

```tsx
// src/routes/blog/route.tsx
import { createRoute } from 'elysion';
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

  layout: ({
    children,
    post,       // ← From loader
    related,    // ← From loader
    params,     // ← Validated { slug: string }
    query       // ← Validated { search?: string, page?: number }
  }) => (
    <BlogLayout post={post}>
      {children}
    </BlogLayout>
  )
});

// src/routes/blog/index.tsx
import { route } from './route';

export default route.page({
  head: ({ data }) => ({
    title: data.post.title,
    meta: [
      { name: 'description', content: data.post.excerpt }
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

### Simple page (no layout, no loader)

```tsx
// src/routes/about/index.tsx
import { createRoute } from 'elysion';

const route = createRoute({ mode: 'ssg' });

export default route.page({
  component: () => (
    <div>
      <h1>About Us</h1>
      <p>...</p>
    </div>
  )
});
```

### Nested layouts

```tsx
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

### Type inference flow

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

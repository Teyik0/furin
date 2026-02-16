# Plan Final - Elysion CreateRoute Architecture

## Vision

Architecture révolutionnaire basée sur `createRoute()` qui combine :
- **Configuration explicite** (pas de magie convention-based)
- **Types parfaits** via décomposition
- **Loaders cascade** avec `parentData` accumulé
- **Fichiers séparés** avec convention de nommage simple

---

## 1. Structure des Fichiers

```
src/routes/
├── index.ts                    # /
├── about.ts                    # /about
├── api/
│   ├── users.ts               # /api/users
│   └── users.$id.ts           # /api/users/:id
├── blog.ts                     # /blog (avec layout)
├── blog.$slug.ts              # /blog/:slug
├── blog.$slug.comments.ts     # /blog/:slug/comments
└── dashboard/
    ├── index.ts               # /dashboard
    ├── layout.ts              # Layout pour /dashboard/*
    ├── settings.ts            # /dashboard/settings
    └── users/
        ├── index.ts           # /dashboard/users
        ├── layout.ts          # Layout pour /dashboard/users/*
        └── $userId.ts         # /dashboard/users/:userId
```

### Convention de Nommage

| Pattern | URL | Description |
|---------|-----|-------------|
| `index.ts` | `/` | Route racine du dossier |
| `about.ts` | `/about` | Route statique |
| `blog.$slug.ts` | `/blog/:slug` | Paramètre dynamique (`$` prefix) |
| `blog.$slug.comments.ts` | `/blog/:slug/comments` | Route imbriquée (`.` separator) |
| `layout.ts` | N/A | Layout pour toutes les routes du dossier |

---

## 2. Interface `createRoute`

### Signature Complète

```typescript
function createRoute<TParams, TQuery, TData>(options: {
  // Routing
  path: string;                    // Path explicif (ex: "/blog/:slug")
  
  // Mode rendu
  mode?: "ssr" | "ssg" | "isr";
  revalidate?: number | false;
  
  // Validation
  params?: AnySchema;              // Validation params (défaut: string)
  query?: AnySchema;               // Validation query string
  
  // Données partagées
  loader?: (ctx: {
    params: TParams;
    query: TQuery;
    parentData: Record<string, unknown>;  // Données des layouts parents
  }) => Promise<TData> | TData;
  
  // Meta tags
  head?: (ctx: {
    params: TParams;
    query: TQuery;
    data: TData;
    parentData: Record<string, unknown>;
  }) => HeadOptions;
  
  // Imbriquement
  children?: RouteConfig[];        // Sous-routes (optionnel)
}): {
  layout: LayoutBuilder<TParams, TQuery, TData>;
  page: PageBuilder<TParams, TQuery, TData>;
  path: string;
  config: RouteConfig;
}
```

### Exemple Complet

```typescript
// src/routes/blog.$slug.ts
import { createRoute } from 'elysion';
import { t } from 'elysia';

const { layout, page } = createRoute({
  path: '/blog/:slug',
  mode: 'ssg',
  revalidate: 3600,
  
  params: t.Object({
    slug: t.String({ minLength: 3 })
  }),
  
  query: t.Object({
    search: t.Optional(t.String()),
    page: t.Optional(t.Number({ default: 1 }))
  }),
  
  // Loader "racine" - exécuté en premier
  loader: async ({ params, query, parentData }) => {
    return {
      post: await getPost(params.slug),
      related: await getRelated(params.slug)
    };
  },
  
  head: ({ data }) => ({
    title: data.post.title,
    meta: [
      { name: 'description', content: data.post.excerpt }
    ]
  })
});

// Layout optionnel
export { layout };
export default layout({
  // Loader layout - reçoit parentData du createRoute
  loader: async ({ params, query, parentData }) => {
    // parentData = { post, related }
    return {
      categories: await getCategories(),
      author: await getAuthor(parentData.post.authorId)
    };
  },
  
  component: ({ 
    children, 
    post,      // ← Du createRoute loader
    categories, // ← Du layout loader
    author,     // ← Du layout loader
    params,     // ← Validés
    query       // ← Validés
  }) => (
    <BlogLayout 
      post={post} 
      categories={categories}
      author={author}
    >
      {children}
    </BlogLayout>
  )
});

// Page obligatoire (ou exportée séparément)
export { page };
export const BlogPostPage = page({
  // Loader page - reçoit parentData accumulé
  loader: async ({ params, query, parentData }) => {
    // parentData = { post, related, categories, author }
    return {
      comments: await getComments(params.slug, query.page),
      isBookmarked: await checkBookmark(parentData.post.id)
    };
  },
  
  component: ({
    // Données createRoute
    post,
    related,
    // Données layout
    categories,
    author,
    // Données page
    comments,
    isBookmarked,
    // Contexte
    params,
    query
  }) => (
    <article>
      <h1>{post.title}</h1>
      <AuthorBadge author={author} />
      <PostContent content={post.content} />
      <CommentsList comments={comments} />
      <RelatedPosts posts={related} />
    </article>
  )
});
```

---

## 3. Layout Optionnel

### Route sans Layout

```typescript
// src/routes/about.ts
import { createRoute } from 'elysion';

const { page } = createRoute({
  path: '/about',
  mode: 'ssg'
});

// Pas de layout exporté
export default page({
  component: () => (
    <div>
      <h1>About Us</h1>
      <p>...</p>
    </div>
  )
});
```

### Layout Multi-Niveaux

```typescript
// src/routes/dashboard/layout.ts
const { layout: dashboardLayout } = createRoute({
  path: '/dashboard'
});

export { dashboardLayout };
export default dashboardLayout({
  loader: async () => ({ user: await getCurrentUser() }),
  component: ({ children, user }) => (
    <DashboardShell user={user}>
      {children}
    </DashboardShell>
  )
});

// src/routes/dashboard/users/layout.ts
import { dashboardLayout } from '../layout';

const { layout: usersLayout } = createRoute({
  path: '/dashboard/users'
});

export { usersLayout };
export default usersLayout({
  loader: async ({ parentData }) => {
    // parentData = { user } du dashboard layout
    return { 
      users: await getUsers(),
      currentUser: parentData.user
    };
  },
  component: ({ children, users, currentUser }) => (
    <UsersLayout users={users} currentUser={currentUser}>
      {children}
    </UsersLayout>
  )
});
```

---

## 4. Types TypeScript

### Inférence Automatique

```typescript
// Les types sont inférés du createRoute
const { layout, page } = createRoute({
  path: '/blog/:slug',
  params: t.Object({ slug: t.String() }),
  query: t.Object({ page: t.Optional(t.Number()) }),
  loader: async ({ params, query }) => ({
    post: { id: 1, title: 'Hello' }
  })
});

// TypeScript sait automatiquement:
layout({
  loader: async ({ params, query, parentData }) => {
    params.slug // string
    query.page // number | undefined
    parentData.post // { id: number, title: string }
  },
  component: (props) => {
    props.post // { id: number, title: string }
    props.params.slug // string
  }
});

page({
  loader: async ({ params, query, parentData }) => {
    // Mêmes types + données du layout
  },
  component: (props) => {
    // Toutes les données accumulées
  }
});
```

### Définitions de Types

```typescript
// Types internes
interface RouteContext<TParams, TQuery, TParentData> {
  params: TParams;
  query: TQuery;
  parentData: TParentData;
}

interface LayoutLoaderContext<TParams, TQuery, TParentData, TRouteData> 
  extends RouteContext<TParams, TQuery, TParentData & TRouteData> {}

interface PageLoaderContext<TParams, TQuery, TParentData, TRouteData, TLayoutData>
  extends RouteContext<TParams, TQuery, TParentData & TRouteData & TLayoutData> {}

// Builders retournés par createRoute
type LayoutBuilder<TParams, TQuery, TRouteData> = <TLayoutData>(options: {
  loader?: (ctx: LayoutLoaderContext<TParams, TQuery, Record<string, never>, TRouteData>) => Promise<TLayoutData> | TLayoutData;
  component: React.FC<TRouteData & TLayoutData & { 
    children: React.ReactNode;
    params: TParams;
    query: TQuery;
  }>;
}) => LayoutModule;

type PageBuilder<TParams, TQuery, TRouteData> = <TPageData>(options: {
  loader?: (ctx: PageLoaderContext<TParams, TQuery, Record<string, never>, TRouteData, Record<string, never>>) => Promise<TPageData> | TPageData;
  component: React.FC<TRouteData & TPageData & {
    params: TParams;
    query: TQuery;
  }>;
}) => PageModule;
```

---

## 5. Algorithme d'Exécution

### Étapes du Router

```typescript
async function handleRequest(url: string) {
  // 1. Matcher l'URL et trouver la chaîne de routes
  const routeChain = matchRoute(url); // [rootLayout, dashboardLayout, usersPage]
  
  // 2. Valider params et query (une seule fois)
  const { params, query } = await validateParamsAndQuery(
    routeChain.map(r => r.config),
    url
  );
  
  // 3. Exécuter les loaders en cascade
  let accumulatedData: Record<string, unknown> = {};
  const loaderResults: Array<{ type: 'route' | 'layout' | 'page', data: unknown }> = [];
  
  for (const route of routeChain) {
    // CreateRoute loader
    if (route.config.loader) {
      const routeData = await route.config.loader({
        params,
        query,
        parentData: accumulatedData
      });
      accumulatedData = { ...accumulatedData, ...routeData };
      loaderResults.push({ type: 'route', data: routeData });
    }
    
    // Layout loader
    if (route.layout?.loader) {
      const layoutData = await route.layout.loader({
        params,
        query,
        parentData: accumulatedData
      });
      accumulatedData = { ...accumulatedData, ...layoutData };
      loaderResults.push({ type: 'layout', data: layoutData });
    }
  }
  
  // Page loader (dernier)
  const page = routeChain[routeChain.length - 1].page;
  if (page?.loader) {
    const pageData = await page.loader({
      params,
      query,
      parentData: accumulatedData
    });
    accumulatedData = { ...accumulatedData, ...pageData };
    loaderResults.push({ type: 'page', data: pageData });
  }
  
  // 4. Rendu imbriqué
  const html = renderWithLayouts(routeChain, accumulatedData, params, query);
  
  return html;
}
```

### Rendu Imbriqué

```typescript
function renderWithLayouts(routeChain, data, params, query) {
  // Commencer par la page (plus profond)
  const page = routeChain[routeChain.length - 1];
  let element = <page.page.component {...data} params={params} query={query} />;
  
  // Remonter les layouts
  for (let i = routeChain.length - 1; i >= 0; i--) {
    const route = routeChain[i];
    if (route.layout) {
      element = (
        <route.layout.component 
          {...data} 
          params={params} 
          query={query}
        >
          {element}
        </route.layout.component>
      );
    }
  }
  
  return renderToString(element);
}
```

---

## 6. Cas d'Usage Avancés

### Route avec Paramètres Complexes

```typescript
// src/routes/search.ts
const { page } = createRoute({
  path: '/search',
  query: t.Object({
    q: t.String(),
    filters: t.Optional(t.Array(t.String())),
    sort: t.Optional(t.Union([
      t.Literal('relevance'),
      t.Literal('date'),
      t.Literal('popularity')
    ]))
  }),
  
  loader: async ({ query }) => ({
    results: await search(query.q, query.filters, query.sort)
  }),
  
  head: ({ data }) => ({
    title: `Search: ${data.results.query}`
  })
});

export default page({
  component: ({ results, params, query }) => (
    <SearchResults results={results} query={query.q} />
  )
});
```

### API Route

```typescript
// src/routes/api.users.$id.ts
const { page } = createRoute({
  path: '/api/users/:id',
  params: t.Object({ id: t.Number() }),
  
  loader: async ({ params }) => {
    const user = await getUser(params.id);
    if (!user) throw new Error('User not found');
    return { user };
  }
});

export default page({
  component: ({ user }) => user // JSON response
});
```

### Route avec Middleware

```typescript
// src/routes/admin.ts
const { layout, page } = createRoute({
  path: '/admin',
  
  // Middleware inline
  beforeLoad: async ({ params, query }) => {
    const session = await getSession();
    if (!session?.user?.isAdmin) {
      throw redirect('/login');
    }
    return { session };
  },
  
  loader: async ({ parentData }) => ({
    stats: await getAdminStats()
  })
});

export { layout };
export default layout({
  component: ({ children, stats, session }) => (
    <AdminLayout stats={stats} user={session.user}>
      {children}
    </AdminLayout>
  )
});
```

---

## 7. Avantages de Cette Architecture

1. **Types Parfaits** - Déduit automatiquement de la configuration
2. **Pas de Magie** - Tout est explicite dans le fichier
3. **Flexibilité** - Layout optionnel, loaders séparés
4. **Performance** - Loaders cascade avec données accumulées
5. **DX** - Un seul fichier par route, export simple
6. **Testable** - Composants exportables séparément
7. **Pas de Fichiers Générés** - Pure TypeScript

---

## 8. Ordre d'Implémentation

1. [ ] Définir les types de base (`RouteConfig`, `LayoutBuilder`, `PageBuilder`)
2. [ ] Implémenter `createRoute` avec inférence TypeScript
3. [ ] Scanner les fichiers routes avec convention de nommage
4. [ ] Matcher URLs et construire chaîne de routes
5. [ ] Valider params/query avec schémas
6. [ ] Exécuter loaders en cascade
7. [ ] Rendu imbriqué React
8. [ ] Système de cache (revalidate)
9. [ ] Gestion des erreurs (404, 500)
10. [ ] Tests et documentation

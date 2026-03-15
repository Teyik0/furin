import { Database } from "bun:sqlite";

export interface User {
  avatar?: string;
  email: string;
  id: string;
  name: string;
  role: "user" | "admin";
}

export interface Post {
  authorId: string;
  content: string;
  createdAt: string;
  excerpt: string;
  id: string;
  published: number;
  slug: string;
  tags: string;
  title: string;
  updatedAt: string;
}

export interface Comment {
  author: string;
  content: string;
  createdAt: string;
  id: string;
  postId: string;
}

const db = new Database(":memory:");

db.run(`
  CREATE TABLE users (
    id TEXT PRIMARY KEY,
    email TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'user',
    avatar TEXT
  );

  CREATE TABLE posts (
    id TEXT PRIMARY KEY,
    slug TEXT UNIQUE NOT NULL,
    title TEXT NOT NULL,
    excerpt TEXT NOT NULL,
    content TEXT NOT NULL,
    tags TEXT NOT NULL,
    authorId TEXT NOT NULL,
    published INTEGER NOT NULL DEFAULT 1,
    createdAt TEXT NOT NULL,
    updatedAt TEXT NOT NULL,
    FOREIGN KEY (authorId) REFERENCES users(id)
  );

  CREATE TABLE comments (
    id TEXT PRIMARY KEY,
    postId TEXT NOT NULL,
    author TEXT NOT NULL,
    content TEXT NOT NULL,
    createdAt TEXT NOT NULL,
    FOREIGN KEY (postId) REFERENCES posts(id)
  );
`);

const users: User[] = [
  {
    id: "1",
    email: "user@example.com",
    name: "John Doe",
    role: "user",
    avatar: "JD",
  },
  {
    id: "2",
    email: "admin@example.com",
    name: "Admin User",
    role: "admin",
    avatar: "AU",
  },
  {
    id: "3",
    email: "jane@example.com",
    name: "Jane Smith",
    role: "user",
    avatar: "JS",
  },
];

const posts: Post[] = [
  {
    id: "1",
    slug: "introduction-to-furin",
    title: "Introduction to Furin",
    excerpt:
      "Discover Furin, the React meta-framework built on Elysia and Bun for blazing fast web applications.",
    content: `# Introduction to Furin

Furin is a powerful React meta-framework that combines the speed of Bun with the flexibility of Elysia.

## Features

- **File-based routing**: Automatic route generation from your file structure
- **Multiple rendering modes**: SSR, SSG, and ISR support out of the box
- **Nested layouts**: Compose your UI with powerful layout patterns
- **Type safety**: Full TypeScript inference across the stack
- **HMR**: React Fast Refresh for instant development feedback

## Getting Started

\`\`\`bash
bun create furin my-app
cd my-app
bun dev
\`\`\`

## Why Furin?

Furin brings together the best of modern web development:
- Server-side rendering for SEO and initial load performance
- Static generation for maximum speed
- Incremental regeneration for dynamic content
- Full type safety without code generation`,
    tags: "react,bun,elysia,framework",
    authorId: "2",
    published: 1,
    createdAt: "2024-01-15T10:00:00Z",
    updatedAt: "2024-01-15T10:00:00Z",
  },
  {
    id: "2",
    slug: "building-with-tailwind-v4",
    title: "Building Modern UIs with Tailwind CSS v4",
    excerpt:
      "Learn how to leverage Tailwind CSS v4 in your Furin projects for beautiful, responsive designs.",
    content: `# Building Modern UIs with Tailwind CSS v4

Tailwind CSS v4 brings exciting new features and improvements.

## What's New in v4

- **Faster builds**: Improved compilation performance
- **Smaller bundles**: Better tree-shaking and optimization
- **New utilities**: Additional helper classes
- **Better DX**: Enhanced developer experience

## Integration with Furin

Furin supports Tailwind v4 out of the box via \`bun-plugin-tailwind\`.

### Configuration

\`\`\`css
@import "tailwindcss";
\`\`\`

That's it! Start using Tailwind classes in your components.`,
    tags: "css,tailwind,design",
    authorId: "1",
    published: 1,
    createdAt: "2024-01-20T14:30:00Z",
    updatedAt: "2024-01-21T09:15:00Z",
  },
  {
    id: "3",
    slug: "ssr-vs-ssg-vs-isr",
    title: "Understanding SSR, SSG, and ISR",
    excerpt:
      "A deep dive into server-side rendering, static site generation, and incremental static regeneration.",
    content: `# Understanding SSR, SSG, and ISR

Choosing the right rendering strategy is crucial for your application's performance.

## Server-Side Rendering (SSR)

Best for:
- Personalized content
- Real-time data
- SEO-critical pages

## Static Site Generation (SSG)

Best for:
- Marketing pages
- Blogs
- Documentation

## Incremental Static Regeneration (ISR)

Best for:
- E-commerce product pages
- News sites
- Content that updates periodically

## Furin's Approach

Furin makes it easy to use all three strategies in a single application:

\`\`\`tsx
// SSG - no loader
const route = createRoute({ mode: "ssg" });

// SSR - has loader
const route = createRoute({
  loader: async () => ({ data: await fetchData() })
});

// ISR - loader + revalidate
const route = createRoute({
  revalidate: 60,
  loader: async () => ({ data: await fetchData() })
});
\`\`\``,
    tags: "react,ssr,ssg,isr,performance",
    authorId: "2",
    published: 1,
    createdAt: "2024-02-01T08:00:00Z",
    updatedAt: "2024-02-02T11:30:00Z",
  },
  {
    id: "4",
    slug: "nested-layouts-patterns",
    title: "Mastering Nested Layouts",
    excerpt: "Learn how to build complex UI hierarchies with Furin's nested layout system.",
    content: `# Mastering Nested Layouts

Furin's nested layout system allows you to compose your UI in powerful ways.

## How It Works

Each \`route.tsx\` file defines a layout that wraps all nested pages:

\`\`\`
pages/
  route.tsx           # Root layout
  dashboard/
    route.tsx         # Dashboard layout
    posts/
      route.tsx       # Posts layout
      index.tsx       # /dashboard/posts
\`\`\`

## Data Flow

Data flows flat through the component tree:

\`\`\`tsx
// dashboard/route.tsx
loader: async () => ({ user: await getCurrentUser() })

// dashboard/posts/route.tsx
loader: async ({ user }) => ({ posts: await getPosts(user.id) })
// user is available here!

// dashboard/posts/index.tsx
component: ({ user, posts }) => ...
// both user and posts are available
\`\`\`

This flat data flow makes it easy to share data across layouts.`,
    tags: "react,patterns,layouts",
    authorId: "3",
    published: 1,
    createdAt: "2024-02-10T16:45:00Z",
    updatedAt: "2024-02-10T16:45:00Z",
  },
  {
    id: "5",
    slug: "draft-post",
    title: "Draft: Future of Web Development",
    excerpt: "Exploring upcoming trends in web development.",
    content: "This is a draft post...",
    tags: "draft",
    authorId: "2",
    published: 0,
    createdAt: "2024-02-15T10:00:00Z",
    updatedAt: "2024-02-15T10:00:00Z",
  },
];

const comments: Comment[] = [
  {
    id: "1",
    postId: "1",
    author: "Developer",
    content: "Great introduction! Looking forward to more articles.",
    createdAt: "2024-01-16T08:30:00Z",
  },
  {
    id: "2",
    postId: "1",
    author: "React Fan",
    content: "The type safety is amazing. Coming from Next.js, this feels much cleaner.",
    createdAt: "2024-01-17T14:20:00Z",
  },
  {
    id: "3",
    postId: "2",
    author: "Designer",
    content: "Tailwind v4 is a game changer. The build times are incredibly fast!",
    createdAt: "2024-01-22T09:00:00Z",
  },
];

const insertUser = db.prepare(
  "INSERT INTO users (id, email, name, role, avatar) VALUES ($id, $email, $name, $role, $avatar)"
);
const insertPost = db.prepare(
  "INSERT INTO posts (id, slug, title, excerpt, content, tags, authorId, published, createdAt, updatedAt) VALUES ($id, $slug, $title, $excerpt, $content, $tags, $authorId, $published, $createdAt, $updatedAt)"
);
const insertComment = db.prepare(
  "INSERT INTO comments (id, postId, author, content, createdAt) VALUES ($id, $postId, $author, $content, $createdAt)"
);

for (const user of users) {
  insertUser.run({
    $id: user.id,
    $email: user.email,
    $name: user.name,
    $role: user.role,
    $avatar: user.avatar || null,
  });
}

for (const post of posts) {
  insertPost.run({
    $id: post.id,
    $slug: post.slug,
    $title: post.title,
    $excerpt: post.excerpt,
    $content: post.content,
    $tags: post.tags,
    $authorId: post.authorId,
    $published: post.published,
    $createdAt: post.createdAt,
    $updatedAt: post.updatedAt,
  });
}

for (const comment of comments) {
  insertComment.run({
    $id: comment.id,
    $postId: comment.postId,
    $author: comment.author,
    $content: comment.content,
    $createdAt: comment.createdAt,
  });
}

export const queries = {
  getUsers: db.prepare<User[], []>("SELECT * FROM users"),
  getUserById: db.prepare<User, [$id: string]>("SELECT * FROM users WHERE id = $id"),
  getUserByEmail: db.prepare<User, [$email: string]>("SELECT * FROM users WHERE email = $email"),

  getPosts: db.prepare<Post, []>("SELECT * FROM posts ORDER BY createdAt DESC"),
  getPublishedPosts: db.prepare<Post, []>(
    "SELECT * FROM posts WHERE published = 1 ORDER BY createdAt DESC"
  ),
  getPostById: db.prepare<Post, [$id: string]>("SELECT * FROM posts WHERE id = $id"),
  getPostBySlug: db.prepare<Post, [$slug: string]>("SELECT * FROM posts WHERE slug = $slug"),
  getPostsByTag: db.prepare<Post, [$tag: string]>(
    "SELECT * FROM posts WHERE published = 1 AND tags LIKE $tag ORDER BY createdAt DESC"
  ),
  createPost: db.prepare<
    Post,
    {
      $id: string;
      $slug: string;
      $title: string;
      $excerpt: string;
      $content: string;
      $tags: string;
      $authorId: string;
      $published: number;
      $createdAt: string;
      $updatedAt: string;
    }
  >(
    "INSERT INTO posts (id, slug, title, excerpt, content, tags, authorId, published, createdAt, updatedAt) VALUES ($id, $slug, $title, $excerpt, $content, $tags, $authorId, $published, $createdAt, $updatedAt) RETURNING *"
  ),
  updatePost: db.prepare<
    Post,
    {
      $id: string;
      $slug: string;
      $title: string;
      $excerpt: string;
      $content: string;
      $tags: string;
      $published: number;
      $updatedAt: string;
    }
  >(
    "UPDATE posts SET slug = $slug, title = $title, excerpt = $excerpt, content = $content, tags = $tags, published = $published, updatedAt = $updatedAt WHERE id = $id RETURNING *"
  ),
  deletePost: db.prepare<undefined, [$id: string]>("DELETE FROM posts WHERE id = $id"),

  getCommentsByPostId: db.prepare<Comment, [$postId: string]>(
    "SELECT * FROM comments WHERE postId = $postId ORDER BY createdAt DESC"
  ),
  createComment: db.prepare<
    Comment,
    {
      $id: string;
      $postId: string;
      $author: string;
      $content: string;
      $createdAt: string;
    }
  >(
    "INSERT INTO comments (id, postId, author, content, createdAt) VALUES ($id, $postId, $author, $content, $createdAt) RETURNING *"
  ),
};

export function generateId(): string {
  return crypto.randomUUID();
}

export function generateSlug(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

export function parseTags(tagsStr: string): string[] {
  return tagsStr
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
}

export function getAllTags(posts: Post[]): string[] {
  const tagSet = new Set<string>();
  for (const post of posts) {
    for (const tag of parseTags(post.tags)) {
      tagSet.add(tag);
    }
  }
  return Array.from(tagSet).sort();
}

export { db };

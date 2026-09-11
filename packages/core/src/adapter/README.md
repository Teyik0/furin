## Bun adapter

Goal is having 3 modes:

- generate server.js + client/
- generate server (compiled to binary) + client/
- generate server (compiled to binary with client/ [embeded](https://bun.com/docs/bundler/executables.md))

All should be portable.

## Cloudflare adapter

## Vercel adapter

The Vercel target emits Build Output API v3 directly to `.vercel/output`:

- content-hashed browser assets and `public/` files under `static/`;
- one bundled `bun1.4.x` Web Handler under `functions/__server.func`;
- SSG Prerender Functions with build-time fallbacks and no timed expiration;
- ISR Prerender Functions using each route's `revalidate` duration;
- a filesystem-first route table with a server fallback for SSR, APIs, and
  `/_furin/data`.

The generated handler connects Furin cache invalidation to Vercel cache tags
and keeps background ISR work alive with `waitUntil`.

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
- ISR Prerender Functions using each route's `revalidate` duration and a
  build-time fallback when the route has no query or request loader;
- a filesystem-first route table with a server fallback for SSR, APIs, and
  `/_furin/data`.

The generated handler connects Furin cache invalidation to Vercel cache tags
and keeps background ISR work alive with `waitUntil`.

Successful `/_furin/data` responses for SSG/ISR routes share the document's
cache tag and revalidation window. SSR, request-loader, deferred, and failed
navigation responses remain `private, no-store`.

JSON-only navigation data uses a compact JSON envelope. CrossJSON and Route
Frames remain the lossless transports for rich values, shared references,
deferred data, and RSC payloads.

The Vercel Function starts through a lightweight `index.js` bootstrap. Its
first request logs a `vercel_cold_start` event and every dynamic response
exposes `furin_module_init`, `furin_server_init`, `furin_handler_wait`, and
`furin_handler` through `Server-Timing`. `--analyze` writes both Vercel client
and server metafiles under `.furin/build/analysis`.

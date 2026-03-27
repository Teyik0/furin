# Dev Mode HMR

## How it works

```text
FILE EDIT (pages/index.tsx)
         │
         ├──► Bun [serve.static] dev bundler          ──► WebSocket ──► Browser React Fast Refresh (~20ms)
         │    (watches client bundle files)
         │
         └──► bun --hot ?                             NOT triggered — page files never enter
                                                      the server module graph (virtual namespace)
```

```text
SERVER MODULE GRAPH                    CLIENT BUNDLE
(tracked by --hot)                     (tracked by dev bundler)
─────────────────────────────          ──────────────────────────────
server.ts                              .furin/_hydrate.tsx
  └─ furin.ts                            ├─ pages/index.tsx   ← watched
       ├─ router.ts                      ├─ pages/root.tsx    ← watched
       │    └─ pages/root.tsx (layout)   └─ pages/docs/*.tsx  ← watched
       └─ dev-page-plugin.ts

       pages/index.tsx ← NOT here ✓
```

## Request flow

```text
GET /
 │
 ├─ import(`pages/index.tsx?furin-server&t=<now>`)
 │         │
 │         └─► dev-page-plugin onResolve
 │                 path → "furin-dev-page:/…/index.tsx?t=<now>"  (unique per request)
 │                        └── bypasses Bun module cache → onLoad always runs
 │             dev-page-plugin onLoad
 │                 1. strip ?t=… → read file from disk (always fresh)
 │                 2. rewrite ./relative imports → /absolute/paths
 │                 3. return source, loader:"tsx"
 │
 ├─ renderSSR(devRoute, ctx, root)
 │       ├─ run loaders (DB / API / fs, server-side only)
 │       ├─ renderToReadableStream(element)
 │       ├─ fetch /_bun_hmr_entry  ← fresh template each request (chunk hashes change on rebundle)
 │       └─ assemble: <head> + SSR HTML + <script id="__FURIN_DATA__">{loaderData}</script>
 │
 └─► Browser: hydrate SSR HTML using __FURIN_DATA__ (no loader re-execution client-side)
```

## Edit → effect table

| What changed | `--hot` restart | Client HMR | Time |
|---|---|---|---|
| `pages/*.tsx` (component) | No | Yes — React Fast Refresh | ~20ms |
| `pages/root.tsx` (root layout) | Yes — it's in the server graph | Yes | ~600ms |
| `server.ts` / `api/` | Yes | No | ~600ms |
| `components/` | Only if imported by server at startup | Yes | varies |

## Key files

| File | Role |
|---|---|
| `src/dev-page-plugin.ts` | Virtual namespace plugin; cache-busting via `?t=<ms>`; relative→absolute import rewrite |
| `src/router.ts` | Skips page imports at scan time; uses `?furin-server&t=<now>` on each request |
| `src/render/template.ts` | `getDevTemplate()` — no-cache fetch of `/_bun_hmr_entry` |
| `src/build/hydrate.ts` | Generates client entry `_hydrate.tsx` with dynamic `import()` per route |
| `src/plugin/index.ts` | Client strip plugin — removes `loader`/`params`/`query` from client bundles |

## Why `?t=<timestamp>`

Bun caches modules by `(namespace, path)`. Without cache-busting, the first import of a page freezes it. After a file edit, the server would SSR the old version while the client gets fresh HMR code → hydration mismatch. The timestamp makes each request a distinct cache key, forcing a fresh disk read every time.

## Why no template cache

`/_bun_hmr_entry` is fetched fresh on every SSR request. After a client-side rebundle, chunk content hashes change. A stale template pointing at old chunk URLs causes 404s → infinite browser reload loop.

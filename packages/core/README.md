<div align="center">
  <img src="https://raw.githubusercontent.com/teyik0/furin/main/apps/docs/public/furin-logo.webp" alt="Furin" width="120" />
  <h1>Furin</h1>
  <p>React meta-framework powered by Elysia and Bun — file-based routing, SSR, SSG, ISR, and full TypeScript inference.</p>

  <a href="https://www.npmjs.com/package/@teyik0/furin"><img src="https://img.shields.io/npm/v/%40teyik0%2Ffurin?style=flat-square&logo=npm&color=orange" alt="npm version" /></a>
  <a href="https://www.npmjs.com/package/@teyik0/furin"><img src="https://img.shields.io/npm/dm/%40teyik0%2Ffurin?style=flat-square&color=orange" alt="npm downloads" /></a>
  <a href="https://github.com/teyik0/furin/blob/main/LICENSE"><img src="https://img.shields.io/github/license/teyik0/furin?style=flat-square" alt="License" /></a>
  <a href="https://bun.sh"><img src="https://img.shields.io/badge/bun-%3E%3D1.4.0-f5d147?style=flat-square&logo=bun&logoColor=black" alt="Bun" /></a>
  <a href="https://www.typescriptlang.org"><img src="https://img.shields.io/badge/TypeScript-strict-3178c6?style=flat-square&logo=typescript&logoColor=white" alt="TypeScript" /></a>
</div>

---

## Quick Start

```bash
bun create furin@latest my-app
cd my-app
bun install
bun run dev
```

For the shadcn/ui starter:

```bash
bun create furin@latest my-app --template full
```

## Documentation

Full API reference, rendering modes, routing, and deployment guides at **[teyik0.github.io/furin](https://teyik0.github.io/furin/)**.

## Cloudflare Workers

```bash
bunx --bun furin build --target cloudflare
bunx --bun wrangler deploy --dry-run --config .furin/build/cloudflare/wrangler.jsonc
bunx --bun wrangler deploy --config .furin/build/cloudflare/wrangler.jsonc
```

Bun remains the build tool; the emitted `worker.js` runs natively in Workers using Elysia's `workerd` AOT target and Web Standard adapter. Keep the default-exported Elysia app and guard local `.listen()` calls with `if (import.meta.main)`. No custom runtime adapter is required.

The generated Wrangler configuration uses `nodejs_compat` and a separate `assets/` directory. Only browser build outputs and `public/` files enter Workers Assets, never SSR templates, SSG data, or server source maps. Browser assets share a content-hashed `/_client/` namespace across mounted apps; only hashed filenames receive immutable caching. HTML and navigation responses remain `private, no-store`, including SSG responses. SSR, SSG, hydration, navigation, and deferred streaming are supported.

ISR, PPR, RSC, Furin Sync, custom `pageCache` adapters, executable compilation, and private server source maps are rejected initially. Application code must use Workers-compatible APIs; `@elysia/static` mounts are rejected in favor of `public/`. The data cache is isolate-local, not shared durable storage. `--target all` keeps the existing Bun/Vercel/static targets; Workers is opt-in.

`public/_headers` is preserved for static responses, with one reserved `/_client/*` cache rule and room for 99 custom rules. Do not supply `public/_client` or redefine that rule. Server-only file-loader outputs are rejected; move public files to `public/`. Elysia `file()`, filesystem APIs, and module-scope/prebuilt `Response` objects are unsupported application code, not generically detected by the compiler. Construct responses inside request handlers and set Worker response security headers there; static `_headers` rules do not apply to SSR/API responses.

Generated configuration is overwritten on each build. For persistent Worker names, bindings, and secrets, maintain a root `wrangler.jsonc` with `main: ".furin/build/cloudflare/worker.js"` and `assets.directory: ".furin/build/cloudflare/assets"`, retaining the generated compatibility settings.

Local runtime validation uses Miniflare/workerd, including real HTTP requests. Wrangler 4.100.0's local `dev` proxy hangs under Bun 1.4.2 even for a minimal hello-world Worker; its deployment dry-run works. Treat local Wrangler-on-Bun support as a tooling limitation, not a supported preview workflow.

## Replayable mutations

Install `furinSync(sync)` on an Elysia API plugin to make mutations idempotent and replayable by default, and pass the same explicit runtime to `furin({ sync })`. Send an `Idempotency-Key` on every mutation handled by `furinSync()`; routes using `sync: false` or `furinInvalidate()` without `furinSync()` do not require one. Use `sync: false` for payments, uploads, streams, and other non-replayable effects. SQLite `:memory:` is available for development and tests but rejected in production. Use file-backed SQLite for one host, or PostgreSQL/Redis for multi-host replicas. Adapters ship as isolated `@teyik0/furin/sync/*` subpaths.

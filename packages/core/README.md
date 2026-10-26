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

Live queries also support continuous subscriptions outside React with
`createSyncClient` from `@teyik0/furin/sync/client`. See the complete Bun example,
authentication contract and shutdown behavior in the
[sync guide](https://teyik0.github.io/furin/docs/sync#continuous-subscriptions-outside-react).
For a consumer in the same Bun process, `createLocalSyncClient({ app, sync })`
from `@teyik0/furin/sync` follows `treaty(app)` live queries without a listener or socket.

## Web development listener

`furin dev --web` honors a source-owned Elysia `.listen(...)` and awaits its startup hooks. Export the app as default or as `app` if it does not listen during import; the CLI supplies `127.0.0.1:3000` for that form. An explicit `--port` takes priority over `PORT` and changes only the listener port, preserving other options. Release resources in `.onStop()`: hot replacement and cancellation await `app.stop(true)` before replacing/exiting the application. Source-owned listeners should sit outside `import.meta.main`; standalone signal handlers can stay guarded. Desktop-configured applications can use the [web owner bootstrap](../electrobun/README.md#development-and-production) without launching a native host.

## Importable Bun application

`furin build --target bun --output app` builds `.furin/build/bun/app.js` for a
host that imports the application into its own Bun process. The default export
is the composed Elysia application; importing it does not start a listener or
invoke the source entry's `startServer`. Existing named exports (`onShutdown`,
`port`, `idleTimeout`, and `startServer`) remain available to the host.

```ts
const { default: app, onShutdown } = await import("./.furin/build/bun/app.js");
app.listen(0); // The host owns startup and shutdown.
// When shutting down: await onShutdown?.(); await app.stop();
```

Export the Elysia app as default from `src/server.ts` and guard source startup
with `if (import.meta.main) { app.listen(port); }`. Arbitrary source import side
effects are not removed. Move the **whole** Bun output directory with its
`client/` and optional `public/` assets, not just `app.js`.

The equivalent configuration is `bun: { output: "app" }` in `furin.config.ts`.
The build API accepts `bun: { output: "app" }` alongside `target: "bun"`.
Its Bun target manifest sets `appPath` to the importable artifact and
`serverPath` to `null`. Without `output`, or with `output: "server"`, the normal
listening `server.js` output remains unchanged. Explicit output is Bun-only;
`output: "app"` cannot be combined with binary `compile` modes.

## Replayable mutations

Install `furinSync(sync)` on an Elysia API plugin to make mutations idempotent and replayable by default, and pass the same explicit runtime to `furin({ sync })`. Send an `Idempotency-Key` on every mutation handled by `furinSync()`; routes using `idempotent: false` or `furinInvalidate()` without `furinSync()` do not require one. Use `idempotent: false` for payments, uploads, streams, and other non-replayable effects: their invalidations still apply and broadcast. SQLite `:memory:` is available for development and tests but rejected in production. Use file-backed SQLite for one host, or PostgreSQL/Redis for multi-host replicas. Adapters ship as isolated `@teyik0/furin/sync/*` subpaths.

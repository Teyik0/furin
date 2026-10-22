# Relay — web and Electrobun todo app

A small task app demonstrating Furin's desktop integration: **the same pages, React components, loaders and API serve both the browser and the system WebView**.

```text
src/
  desktop.ts                 Native SDK menus/tray and getDesktopHost coordination
  server.ts                  Elysia root: desktopApp({window}) first, then the typed API and furin()
  sync.ts                    Furin Sync runtime (Drizzle adapter, single local principal)
  db/                        bun:sqlite + Drizzle client and schema
  api/                       /api plugin; modules/todos/{index,model,service}.ts
  lib/api.ts                 Isomorphic Eden client: in-process on the server, HTTP in the browser
  pages/                     root layout and the "/" page
  components/todo-app.tsx    UI: useMutation with optimistic cache.update
```

The page loader reads `api.todos.get.live()`. Every mutation invalidates `GET /api/todos`, so the
page refreshes in every open window, including the desktop one, without manual refresh code.

## Run

From the repository root:

```sh
bun install
cd examples/electrobun-todo
bun run dev
```

The `@teyik0/furin-electrobun/preload` registered in `bunfig.toml` opens the desktop window and an
authenticated browser on one backend. Packaging settings live in `furin.config.ts`; the primary window lives in `server.ts`.

`desktop.build.bun.entrypoint` selects `src/desktop.ts` using Electrobun's keys.
The generated bootstrap loads it after the app module and before Elysia startup. `.use(desktopApp({ window: ... }))` opens
the native window after readiness; no host launch call is needed.
This optional module imports the SDK through `electrobun/main`; server and browser modules
remain independent of native imports. `bun run tscheck` prepares the SDK and its
generated TypeScript paths before checking the app.

## Production

```sh
bun run build && bun run start   # web, port 3004
bun run build:desktop            # Electrobun app in .furin/electrobun
```

## Data

- Web: `.furin/todos.sqlite`.
- Desktop: `todos.sqlite` in `FURIN_APP_DATA_DIR`, set by the desktop host before importing the server.
- `FURIN_TODO_DATABASE` overrides the filename in both modes (tests use a shared in-memory database).

The table is created at startup; a schema change needs a migration for existing databases.

## Verify

```sh
bun run tscheck
bun run test
```

See the [integration package](../../packages/electrobun/README.md) for the server contract, packaging and limitations.

The independent `/api/desktop` plugin installs `desktopContext`. Its minimize action calls the original SDK window method and returns a typed 409 in web mode. Native menus/tray use the SDK directly; `/host` returns the same live controller. No native launch call or window declaration module is required.

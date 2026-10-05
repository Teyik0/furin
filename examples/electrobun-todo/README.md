# Relay — web and Electrobun todo app

A small task app demonstrating Furin's desktop integration: **the same pages, React DOM components, loaders and API serve both the browser and the system WebView**.

The server root uses `createDesktopApp()` from `@teyik0/furin-electrobun/server`.
It returns an Elysia instance with a desktop session wrapper installed before
application middleware. That wrapper is inactive for ordinary web execution;
no separate frontend or backend implementation is needed.

## Run

From the repository root:

```sh
bun install
bun run --filter @teyik0/furin build
bun run --filter @teyik0/furin-electrobun build
cd examples/electrobun-todo
bun run dev
```

The web app listens on `http://127.0.0.1:3004`. To open the desktop app:

```sh
bun run dev:desktop
```

Desktop settings live in `furin.desktop.config.ts`. The first command prepares the pinned Electrobun SDK automatically; developers do not write a native entrypoint or an asset-copy script.

## Desktop production

```sh
bun run build:desktop
```

The package builds an inert application, copies its resources and loads it in Electrobun's main Bun process. A private ephemeral-port listener serves the native WebView; production does not spawn a child backend. Artifacts live in `.furin/electrobun/build` and `.furin/electrobun/artifacts`.

Development uses an ordinary Bun helper to preserve plugins and Furin Fast Refresh. JSX and CSS updates were verified in a real WKWebView without losing the draft or reloading the document. Backend edits restart the backend and reopen the window; a separate native test verified old-process termination, a new document, sync readiness and persisted tasks. Unsaved React state is not preserved across a backend restart.

## Data

- Web: `.furin/todos.sqlite`, or `FURIN_TODO_DATABASE`.
- Desktop: `todos.sqlite` in `FURIN_APP_DATA_DIR`, set by the integration before importing the backend.
- Desktop startup does not automatically migrate an existing web database.

Creation, editing, deletion, validation and idempotent replay use the same Elysia/Drizzle/SQLite API. The Furin journal triggers page refreshes. Drafts typed while a request is pending are not overwritten by its response.

Web and desktop defaults use separate storage locations. This example does not synchronize two different databases; clients must use the same backend to share a library.

## Verify

```sh
bun run tscheck
bun run test
bun run build
```

The retained tests cover the backend, durable mutations, SSR/loaders, drafts and synchronization failures. Tests for the removed renderer and comparison benchmarks are no longer part of the example.

See the [integration package](../../packages/electrobun/README.md) for the server contract, packaging and limitations.

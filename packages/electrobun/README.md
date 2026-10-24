# @teyik0/furin-electrobun

Furin desktop packaging with Electrobun 2.0.2 and one Bun main process. Your React DOM pages, SSR, API, Eden client and sync code serve both web and desktop.

## Setup

```sh
bun add -d @teyik0/furin-electrobun
bunx --bun @teyik0/furin-electrobun init
```

Declare packaging in `furin.config.ts`. The primary window belongs in the Elysia root:

```ts
// furin.config.ts
import { defineConfig } from "@teyik0/furin/config";
import { defineDesktopConfig } from "@teyik0/furin-electrobun";

export default defineConfig({
  desktop: defineDesktopConfig({
    app: { name: "Relay", identifier: "local.furin.relay" },
    build: { mainProcess: "bun", bun: { entrypoint: "src/desktop.ts" } },
  }),
});
```

```ts
// src/server.ts
import { furin } from "@teyik0/furin";
import { desktopApp } from "@teyik0/furin-electrobun/server";
import { Elysia } from "elysia";
import { api } from "./api";

const app = new Elysia()
  .use(desktopApp({
    window: {
      title: "Relay",
      frame: { width: 1100, height: 780 },
      titleBarStyle: "hiddenInset",
      renderer: "native",
    },
  }))
  .onStart(async () => { await database.open(); })
  .onStop(async () => { await database.close(); })
  .use(api)
  .use(await furin({ pagesDir: "src/pages" }))
  .listen({ hostname: "127.0.0.1", port: 4242 });

export default app;
```

The generated host opens the window after every Elysia startup hook succeeds. No application launch function is required. Source entries may also own `.listen()` without a default export; Furin's production app artifact remains inert on import. Install `desktopApp` before listening. It preserves the original root identity, prefixes, decorators, routes and Eden inference.

## Listener configuration

Use Elysia's `.listen(...)` as the source of truth for the application server. The desktop window and browser clients share that server in the same Bun process:

```ts
const app = new Elysia()
  .use(desktopApp({ window: { title: "Relay" } }))
  .use(api)
  .listen({ hostname: "127.0.0.1", port: 4242 });

export default app;
```

Both web and desktop use port `4242`. Pass `tls` to `.listen(...)` for HTTPS; advanced Elysia `serve` defaults remain available and explicit listener options override them. Builds capture the listener options without opening a socket or running startup hooks, and the desktop host starts the built application with those options. Put shared startup work in `.onStart()`.

An entry that only default-exports its application remains supported: without a configured hostname or port, the desktop host uses `127.0.0.1` and a free port. To accept network clients, use `0.0.0.0` or `::` and configure `desktopApp.admission` to authenticate requests. Managed windows always connect through `127.0.0.1`; Unix sockets and hostnames that exclude that interface are rejected. Existing `restrictWebToLoopback` checks still apply.

## Configuration from Elysia services

`desktopApp` accepts a configuration object, an inline factory, or the application and a factory. A factory receives the decorators registered before it and the shared `store`, with their inferred types:

```ts
import { desktopApp } from "@teyik0/furin-electrobun/server";
import { Elysia } from "elysia";
import { services } from "./services";

new Elysia()
  .use(services)
  .use(desktopApp(({ access, torrents, instance }) => ({
    admission: access.admit.bind(access),
    background: () => torrents.settings.runInBackground === true,
    window: {
      frame: { height: 940, width: 1400 },
      renderer: "native",
      title: instance.name,
    },
  })));
```

Here, `services` is an Elysia plugin that decorates `access`, `torrents`, and `instance`. The explicit application form provides the same context:

```ts
new Elysia()
  .use(services)
  .state("background", false)
  .use((app) => desktopApp(app, ({ instance, store }) => ({
    background: () => store.background,
    window: { title: instance.name },
  })));
```

The factory runs synchronously once when the plugin is installed, before listening. Its services must already be registered and usable; it does not wait for `.onStart()` or pending async plugins. Values such as `window.title` are read then. `admission` and `background` remain callbacks and read shared services when invoked. The configuration context contains no HTTP request fields or per-request `.derive()` values.

## Independent API plugins

```ts
import { desktopContext } from "@teyik0/furin-electrobun/server";
import { Elysia, status } from "elysia";

export const api = new Elysia({ prefix: "/api" })
  .use(desktopContext)
  .post("/minimize", ({ desktop }) => {
    if (!desktop) return status(409, { error: "Desktop unavailable" });
    desktop.window?.minimize();
    return { ok: true };
  });
```

`desktopContext` is a named, deduplicated dependency provider. It only injects the live `DesktopContext | null`; it does not register another root, listener or window. `desktopApp` installs it automatically. Independent plugins explicitly `.use(desktopContext)` to get their own static types. Web mode gets `null` without loading native SDK code.

`desktop.window` is a readonly getter returning the current **original SDK BrowserWindow**, or `undefined` after it closes. It includes every native method and the original `webview`/RPC types. `desktop.open()` reactivates main or creates it again and returns that real instance. Before native readiness, it throws immediately; do not call it at native-module top level or await it during startup.

```ts
const options = desktop.windows.create("options", {
  path: "/options",
  title: "Options",
  frame: { width: 640, height: 480 },
  rpc,
});
// BrowserWindow<typeof rpc>, including BrowserView<typeof rpc>.
options.webview.rpc;
desktop.windows.get("options"); // BrowserWindow | undefined
```

Each additional window gets its own one-use authenticated bootstrap URL. Names are dynamic strings; a lookup cannot infer a schema from an unrelated string declaration. Keep the inferred result of `create` when exact RPC typing matters. The ambient main getter uses the SDK's default RPC type. No generated named-window declarations are involved.

Furin reserves managed window URLs, HTML, views root and navigation rules. Other SDK options pass through. Managed windows without RPC default to sandboxed; supplying RPC enables its SDK transport unless you explicitly choose sandbox mode. Trusted native code can use original SDK methods to change a window later. Raw SDK windows/views are also available and are outside Furin's managed authentication and ownership.

## Native modules use the original SDK

The optional `build.bun.entrypoint` module registers native integrations. It runs internally after the application module loads, before Elysia startup/listening. It must not start the backend or declare a primary window.

```ts
// src/desktop.ts
import { ApplicationMenu } from "electrobun/main";
import { getDesktopHost } from "@teyik0/furin-electrobun/host";

ApplicationMenu.setApplicationMenu([
  { label: "Relay", submenu: [{ label: "Open Relay", action: "open" }, { role: "quit" }] },
]);
ApplicationMenu.on("application-menu-clicked", () => {
  Promise.resolve().then(() => getDesktopHost()?.open())
    .catch(() => console.error("Native action failed"));
});
```

Handle deep links and associated files directly with `Electrobun.events.on("open-url", handler)` in this native entrypoint, using the original SDK's `event.data.url` payload. Files arrive as `file:` URLs. Declare URL schemes/file associations in `desktop.app.urlSchemes` / `desktop.app.fileAssociations`. Furin forwards launch inputs and secondary-instance inputs to this SDK event after host readiness; direct OS events follow the SDK lifecycle. Coordinate application startup dependencies in your native handler when needed. Furin provides no `onOpen` option or native-module export contract.

`getDesktopHost()` returns the same controller as route context, or `null` outside the managed host. Original `electrobun/main` and all devkit public subpaths remain available: ApplicationMenu, ContextMenu, Tray, Utils, GlobalShortcut, Screen, Session, BrowserWindow, BrowserView/RPC, GpuWindow, WGPUView and WebGPU. Use SDK menus with their original tooltip/hidden/data/roles/actions; create and update SDK trays directly. Furin installs no replacement menus or tray.

Native callbacks run outside HTTP; catch both synchronous errors and rejected promises there. Elysia `.onError()` handles HTTP errors. Application resource lifecycle uses Elysia `.onStart()`/`.onStop()`. Keep native SDK value imports confined to native modules; shared server modules use context and type-only imports.

Furin retains `desktop.browser.open(path)`, coordinated `quit()`/`restart()`, `updates.install()`, association helpers, identity/instance ownership, native input forwarding and background/admission policy. Use original SDK Updater for checking, downloading and status. Installation drains the backend before SDK handoff. Quit/restart guard all managed windows and run backend cleanup once. `background: () => true` permits the app to stay alive after the last managed window closes; native menus/trays remain application-owned.

## Packaging and types

`DesktopConfig` derives compatible options from the original SDK `ElectrobunConfig`: platform settings, permissions, signing, views, copy, bundler options, scripts and release settings. `app.version` defaults to the consuming package version. Furin owns the generated main entry, inert app artifact, required helpers/copy destinations and `exitOnLastWindowClosed`; `mainProcess` must be `"bun"` for this in-process backend.

CEF and WGPU are off by default. Explicit `build.mac`, `build.win` or `build.linux` `bundleCEF: true` / `bundleWGPU: true` opt in. A CEF managed window requires CEF enabled for the current platform; `defaultRenderer: "cef"` likewise requires it. Native remains the default renderer. Packaging assets and renderer selection must agree.

The npm Electrobun package is a launcher, not its API declarations. Prepare the pinned devkit and extend its generated paths before checking native code:

```sh
bunx --bun furin-electrobun prepare
```

```json
{
  "extends": ["./.furin/electrobun/tsconfig.json", "../../tsconfig.base.json"]
}
```

Preserve your existing compiler options instead of copying the example's second extends path. `prepare`, `dev` and desktop builds regenerate exact aliases from the SDK export map; rerun preparation after relocating a checkout. Published Furin declarations reference original `electrobun/main` types, never a build machine's absolute paths. No GUI is needed to prepare/typecheck. First preparation needs network access; later runs reuse Hutch's cache. The optional SDK dependency is pinned to 2.0.2; install it explicitly if optional dependencies were omitted. All tools run through Bun.

## Development and production

`init` adds `build:desktop`, preserves existing dev commands and config, and registers this launcher in `bunfig.toml`:

```toml
preload = ["@teyik0/furin-electrobun/preload"]
```

```sh
bun --hot src/server.ts       # native and authenticated browser, one backend
bunx --bun furin dev --web    # web mode, no SDK initialization
bun run build:desktop        # package the native app
```

The preload only activates for the configured hot server entry. Frontend edits use Bun HMR/React Fast Refresh and retain the window. Backend/native dependency edits cause a controlled full process restart; native modules are never hot-reloaded and backend state is not promised to survive. External packages/assets/native dependencies stay with the relocatable Furin artifact. Compiled/AOT dispatch preserves app identity and the in-process Eden security boundary.

See [native-host.md](./native-host.md) for session, listener, storage and lifecycle details, and [the todo example](../../examples/electrobun-todo) for working code.

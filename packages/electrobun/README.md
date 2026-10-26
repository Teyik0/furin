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

An entry that only default-exports its application remains supported: without a configured hostname or port, the desktop host uses `127.0.0.1` and a free port. Managed windows use the application's listener hostname, scheme and port. Wildcard listeners use a local destination: `0.0.0.0` becomes `127.0.0.1`, and `::` becomes `[::1]`. Explicit hostnames, including `localhost`, IPv6 and LAN addresses, are preserved. To accept network clients, configure `desktopApp.admission` to authenticate requests. Unix sockets are rejected because the WebView requires an HTTP(S) address. Existing `restrictWebToLoopback` checks still apply.

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

Web-only development evaluates the source entry and honors its direct `.listen(...)`, including the hostname, TLS, port and Elysia startup/stop hooks. Keep that call outside `import.meta.main`; keep standalone process signal handlers inside the guard. For example:

```ts
const app = new Elysia()
  .use(desktopApp({ admission: access.admit.bind(access) }))
  .use(api);
export default app;
app.listen({ port: instance.port });
```

There is no startup wrapper to export. `--port` (then `PORT`) overrides only the source listener port. An unlistened default/named `app` export remains supported, with a loopback listener on port 3000 when no override is supplied. Web hot replacement awaits `app.stop(true)` before evaluating the next source graph, so release exclusive resources in `.onStop()`.

With `desktopApp`, the CLI opens an authenticated owner session in the system browser, without starting Electrobun. Its single-use bootstrap URL expires after one minute and is sent directly to the browser, never printed or saved. It uses the application origin (HTTP or HTTPS), a host-only HttpOnly SameSite=Strict cookie, and Secure on HTTPS. HTTPS development needs a certificate trusted by the browser. Only a verified cookie on the exact local origin, from a loopback TCP peer without forwarded headers, sets `desktopSession: true`. `desktopHost` remains false, the native host context remains null, and the React desktop client remains in web mode. Missing/invalid owner cookies and remote requests continue through the application's admission policy; existing paired remote authentication is unchanged. No consumer client changes or remote-access setting changes are required. This bootstrap is activated only by the development CLI and never by production/package startup. A loopback or wildcard TCP listener and an available system browser are required.

The preload only activates for the configured hot server entry. Frontend edits use Bun HMR/React Fast Refresh and retain the window. Backend/native dependency edits cause a controlled full process restart; native modules are never hot-reloaded and backend state is not promised to survive. External packages/assets/native dependencies stay with the relocatable Furin artifact. Compiled/AOT dispatch preserves app identity and the in-process Eden security boundary.

See [native-host.md](./native-host.md) for session, listener, storage and lifecycle details, and [the todo example](../../examples/electrobun-todo) for working code.

## React host capabilities

Import `useDesktop` from `@teyik0/furin-electrobun/client`. This entrypoint is safe to import and render during SSR; its Web bundle contains React and the small event-bridge client, with no server or native SDK imports. React is an optional peer, required only for this entrypoint. No provider, server action or application endpoint is required.

```ts
import { useDesktop, type DesktopClient, type OpenBrowserResult } from "@teyik0/furin-electrobun/client";

// DesktopClient
// status: "initializing" | "web" | "desktop" | "unavailable"
// browser.open(url: string): Promise<OpenBrowserResult>
//
// OpenBrowserResult
// { ok: true }
// | { ok: false; reason: "unavailable" | "invalid-url" | "open-failed" }
```

`initializing` is the SSR/hydration snapshot and remains until the native handshake completes. `web` means the current page has no Electrobun event bridge. `desktop` means its managed native window acknowledged the handshake. `unavailable` means a present bridge did not acknowledge within five seconds, or stopped acknowledging an opening request. Availability describes the **current interface**, independently of where the backend runs: a remote browser connected to a desktop backend remains `web`.

`browser.open` asks the operating system to open a URL in its associated application (the system browser for HTTP(S)). It resolves only after native acknowledgement. `ok: true` means `Utils.openExternal` accepted the request; it does not confirm that a page loaded or a download succeeded. Missing/closed/unresponsive bridges return `unavailable`; native false results and exceptions return `open-failed`. Requests time out after five seconds. A timeout cannot prove that an already dispatched native action never ran. Unmounting cancels pending waits and releases their listeners/timers; remount to retry a failed availability handshake.

HTTP, HTTPS and `mailto:` are allowed, matching native external navigation. `javascript:`, `data:`, `file:`, custom schemes, malformed URLs and URLs with embedded username/password are refused. Relative URLs resolve against `window.location.href` **at the time of the call**, including the current pathname, not an HTML `<base>` or the backend's filesystem. The host independently validates the resulting absolute URL and refuses its private session-bootstrap origin. Same-origin application URLs are allowed for downloads; ordinary webview navigation retains its existing app-origin restrictions. The command and result are typed; URLs are plain strings, with no claim of application-route inference.

The hook uses Electrobun's documented event-only `host-message` bridge and a native acknowledgement on the same window. Sandboxing stays enabled by default and existing application RPC objects/transports are preserved. Native SDK capabilities beyond `browser.open` remain in the native module or server context; they are not exposed to the page.

### Download link with desktop behavior

```tsx
import { useState } from "react";
import { useDesktop } from "@teyik0/furin-electrobun/client";

export function DownloadLink({ url }: { url: string }) {
  const desktop = useDesktop();
  const [error, setError] = useState<string | null>(null);

  return (
    <>
      <a
        href={url}
        onClick={(event) => {
          if (desktop.status !== "desktop") return;
          event.preventDefault();
          setError(null);
          void desktop.browser.open(url).then((result) => {
            if (!result.ok) setError("Impossible d’ouvrir le navigateur système.");
          });
        }}
      >
        Télécharger la mise à jour
      </a>
      {error && <p role="alert">{error}</p>}
    </>
  );
}

// Same-origin URL or an application-provided HTTPS download URL:
// <DownloadLink url="/api/updates/download" />
```

SSR and Web render a regular anchor. Once the desktop handshake succeeds, clicking uses the system browser. In Tofu, replace the call to `POST /api/updates/open-download` with this hook and delete that action endpoint; keep `GET /api/updates/download` solely to serve the file. These Tofu routes are not part of this repository.

**Authentication:** the system browser does not necessarily share the webview's cookies, local storage or application session. This API opens the supplied URL without forwarding credentials, adding tokens, or issuing a session bootstrap. A protected download may therefore require browser sign-in or an application-issued, short-lived download URL with appropriate scope. Furin's private loopback listener also requires its desktop cookie, so opening its plain `/api/updates/download` URL in a separate browser may return 401. Use a download URL the system browser can legitimately access; do not expose the desktop bootstrap cookie or remove listener/authentication protections to make it work. The host-side `desktop.browser.open(path)` remains a separate existing operation for launching the application with its own session-bootstrap policy.

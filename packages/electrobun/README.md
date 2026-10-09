# @teyik0/furin-electrobun

Official desktop packaging for Furin, using **Electrobun 2.0.2**, one Bun main
process and a single system-native WebView. Your existing React DOM UI, SSR,
RSC, routes, API, `useQuery` and sync code remain web code. No custom React
renderer, native UI framework, generic RPC bridge or CEF is installed in the
web app or Furin core.

## Setup

From the consuming Furin app:

```sh
bun add -d @teyik0/furin-electrobun
bunx --bun @teyik0/furin-electrobun init
```

Desktop settings live in the `desktop` section of `furin.config.ts`.
`init` creates that file if it is absent and adds the two package scripts.
If a Furin config already exists, add its desktop section first: `init` does
not parse and rewrite application plugins or functions. Existing desktop scripts
are refused. Manifest replacement and new configuration publication are atomic.
The former standalone `furin.desktop.config.ts` is not read.

Update the server constructor as described below, then run:

```sh
bun run dev:desktop
bun run build:desktop
```

```ts
import { defineConfig } from "@teyik0/furin/config";
import { defineDesktopConfig } from "@teyik0/furin-electrobun";

export default defineConfig({
  desktop: defineDesktopConfig({
    app: { name: "Relay", identifier: "local.furin.relay" },
    window: { width: 1024, height: 768 },
  }),
});
```

`app.version` is optional and otherwise comes from the consuming `package.json`.
Dimensions must be positive integers, and `identifier` must be a reverse-domain
identifier. `dataDir`, when provided, must be an absolute path.

The SDK bootstrap is an optional, exactly pinned package dependency. If your
installation omitted optional dependencies, run `bun add -d electrobun@2.0.2`.
The CLI runs its CJS entry through the current Bun executable, not Node or npm.
Hutch prepares the matching SDK projection automatically. First preparation
requires network access; subsequent builds reuse the toolchain cache.

Hutch is Electrobun's toolchain manager. Its SDK projection is the generated
API and native toolchain under `.furin/electrobun/.hutch/devkit`, not another
application framework or a directory developers maintain by hand.

## Server contract

Furin detects the existing `furin.config.ts` / `.js` / `.mjs`, `rootDir` and
`serverEntry` conventions. With no explicit server entry, it uses `src/server.ts`.
The server must default-export an inert Elysia root with `desktopApp()` as its
first plugin, before wrappers or application plugins:

```ts
import { furin } from "@teyik0/furin";
import { desktopApp } from "@teyik0/furin-electrobun/server";
import { Elysia } from "elysia";

const app = new Elysia()
  .use(desktopApp({
    restrictWebToLoopback: true,
    async onStartup(signal) {
      await database.open(signal);
    },
    async onShutdown() {
      await database.close();
    },
  }))
  .use(furin({ pagesDir: "src/pages" }));

export default app;

// Normal web boot remains unchanged when this file is executed directly.
if (import.meta.main) {
  app.listen({ hostname: "127.0.0.1", port: 3000 });
}
```

Desktop imports must not start a listener. An already listening app is rejected
with a migration diagnostic; the CLI does not try to strip arbitrary `.listen`
calls from your code.

The functional plugin preserves the original Elysia identity, prefix, decorators
and route inference. Installing it after a wrapper or after listening is rejected.
Application routes remain ordinary Elysia plugins.

`onStartup` and `onShutdown` run once per app lifecycle in web and desktop modes.
Web uses Elysia setup/cleanup; the desktop host initializes resources before its
listener opens. Callbacks are options, not required named module exports.
They must tolerate partial initialization and honor startup cancellation.

The desktop session is always mandatory. `restrictWebToLoopback` optionally adds
local-host and mutation-origin checks to ordinary web requests, and refuses a web
listener bound to a non-loopback hostname. It does not disable desktop protection.
With this option omitted, ordinary web requests are not session-protected.

The desktop host imports and listens to that same root; it does not remount the
application inside another Elysia instance. Change the original constructor,
rather than wrapping a complete existing Furin app in a new parent. Rehosting
changes final-root ownership: apps using sync must bind `furinSync(sync)` on the
new final root too, as described in the
[sync composition contract](../../apps/docs/src/content/docs/sync.mdx).

## Development

The default host uses two Bun processes during development: an ordinary Furin dev helper
running from the consuming root, and the SDK window host. This preserves the
original `bunfig.toml` `[serve.static]` plugins, public environment filtering,
Tailwind and Furin's frontend Fast Refresh without copying configs or changing
SDK directories. There is no Vite process or replacement frontend.

Frontend edits use Furin frontend HMR. The supervisor follows literal runtime
imports from the server and custom host, including backend JSX/TSX and transitive
imports; type-only imports and frontend-only TS helpers do not restart the backend.
Modules loaded through computed paths are outside this source graph.
A real macOS WKWebView test
verified both kinds of update while preserving a React-controlled draft,
document identity and native-host PID.

Changes to backend source trigger controlled shutdown and relaunch. A separate
real WKWebView test verified old-host termination, a new native host and document,
sync readiness, and a task persisted before the restart. Backend changes replace
the window/document; preservation of unsaved React state is not promised.
Closing the window or stopping the CLI drains the owned dev backend. This
development-only helper is not packaged: production always imports `app.js`
in-process.

## Production

`build` invokes `furin build --target bun --output app`, copies the **whole**
Bun output (including all client directories and public resources) under
`.furin/electrobun`, then prepares and builds Electrobun. The user does not write
SDK setup scripts or copy assets manually.

The SDK main dynamically imports the copied `app.js` **as a separate file**.
It is not bundled into the SDK entry, avoiding multiple AOT application graphs
and duplicate native ABI state. The app listens once on `127.0.0.1`, port `0`;
the native window opens that same origin. There is no child backend Bun process.
Output is in `.furin/electrobun/build` and distribution artifacts in
`.furin/electrobun/artifacts`.

The host sets `FURIN_APP_DATA_DIR` **before importing server code**, creates
the directory, and leaves production CWD unchanged. By default it is the OS
app-data directory joined with `app.identifier`. Your ordinary server-side
database factory can read that environment variable:

```ts
const databasePath = process.env.FURIN_APP_DATA_DIR
  ? `${process.env.FURIN_APP_DATA_DIR}/todos.sqlite`
  : ".furin/todos.sqlite";
```

No existing user data is moved. An absolute `dataDir` override is available for
applications that already own a storage location.

The plugin may provide `onStartup(signal: AbortSignal)` to initialize resources
before the private listener opens. Startup failure calls its cleanup; the signal
is aborted on cancellation, so initialization must honor it and release any late
resources. The hook must not call `listen()`.

Window close and app quit stop the server and call plugin cleanup once,
then use the SDK's public window close and quit APIs. Startup diagnostics print
the identifier, private origin and data path. SIGUSR-based reload is not used:
the SDK-managed Bun currently does not implement it.

Cleanup has a fixed five-second grace period. On timeout, the host reports the
failure and quits unsuccessfully; the dev supervisor kills and reaps its owned
helper rather than leaving it running indefinitely.

Desktop startup waits up to thirty seconds for Elysia's async plugins and setup
to complete. Timeout closes the owned backend and runs `onShutdown`; a plugin
that finishes after cancellation cannot open a late listener.

## External packages and native addons

Use `external` to declare runtime packages that must be copied alongside the
inert app, for example:

```ts
export default defineConfig({
  desktop: defineDesktopConfig({
    app: { name: "Tofu", identifier: "app.tofu.torrents" },
    window: { width: 1200, height: 800 },
    external: ["webtorrent", "parse-torrent"],
  }),
});
```

**This is a packaging declaration, not automatic bundler externalization.**
Keep your existing server-only externalization in `furin.config.ts` Bun
plugins. A package bundled into `app.js` cannot recover file-relative native
resources merely because it was also copied.

The packager follows installed runtime dependencies, optional dependencies
when present, and peers, resolving each from its actual importing package.
It materializes package files, assets and binaries as real directories/files,
preserves distinct installed versions and reconstructs each importer's dependency
resolution. No directory or asset symlink is passed to the SDK archive builder:
links escaping the declared package, cyclic asset links and links into the
source `node_modules` are rejected. Ordinary dependency cycles and materializable
package aliases are supported. Conflicting-version cycles that cannot form a
finite, symlink-free Node-resolvable tree are rejected explicitly.
It does not copy the entire project `node_modules` or development dependencies.

This is minimum coherent native-package support, **not a guarantee that any
N-API addon works**. The addon must support the SDK's Bun version and target
OS/architecture; binaries must already be installed or built by the consuming
project. Platform-specific signing and addon compatibility require testing
the packaged application on the target machine.

## Security and scope

The native navigation policy denies all origins except the private app origin
and a package-owned loopback bootstrap origin.
External HTTP(S) and mail links are handed to the OS browser. The window is
sandboxed, with `views:` / `appData:` protocols and RPC capabilities disabled.
A dedicated listener issues a uniquely named `HttpOnly; SameSite=Strict`
session cookie and redirects to the app. Its independent bootstrap nonce is
accepted once; the spent listener remains bound until shutdown to prevent
port rebinding. Bootstrap credentials never enter the user application's
request hooks or access logs. This adds a listener, not a production process.

`desktopApp()` registers the session wrapper first, outside application
request hooks, cache wrappers and plugin wrappers. The host activates that
specific root's guard before listening. Missing credentials, cross-origin and
cross-site requests are rejected before user middleware can return an early
response. No Elysia modification or extra proxy is needed.

Native Bun routes can bypass Elysia dispatch, so desktop startup rejects
`serve.routes` and custom adapters, and disables promoted static responses.
Production also rejects native HTMLBundle handlers. Development permits only
GET `.../_bun_hmr_entry[/index.html]` frontend assets and Bun's native HMR
infrastructure: these development assets are public and must not contain
secrets. Native-route policy is checked before listening and again after all
setup hooks, before bootstrap readiness.

This guards application HTTP and WebSocket dispatch, not hostile code running
inside the application's own Bun process. Do not replace native server handlers
to bypass the factory. Loopback is not a substitute for application authorization.

## Application-owned native hosts

Applications that already manage trays, menus, background windows or updates can
set `hostEntry` to their own Bun entrypoint. Furin still builds and copies the
inert app and its external dependency closure; the SDK bundles the custom host.
The standard generated host remains the default.

```ts
export default defineConfig({
  desktop: defineDesktopConfig({
    app: { name: "Tofu", identifier: "app.tofu.torrents", version: "0.2.1" },
    window: { width: 1400, height: 940 },
    hostEntry: "src/desktop-host.ts",
    external: ["webtorrent", "parse-torrent"],
    sdk: {
      app: { urlSchemes: ["magnet", "tofu"] },
      build: { mac: { icons: "assets/tofu.iconset", codesign: true } },
      release: { baseUrl: "https://example.com/releases" },
    },
  }),
});
```

`sdk` accepts typed additions for schemes, file associations, platform icons,
macOS signing, helper-file copies, Bun externals and the update feed. Source
paths are resolved from the application's root. Copy destinations cannot replace
Furin's `furin` artifact. Furin retains Bun entrypoint, renderer and runtime
ownership in the generated SDK configuration.

Custom entrypoints can use `runDesktopHost(sdk, setup)` from
`@teyik0/furin-electrobun/host`. Import the canonical SDK in the application
entrypoint and pass it explicitly, preserving its complete inferred types:

```ts
import * as sdk from "electrobun/main";
import { runDesktopHost } from "@teyik0/furin-electrobun/host";

await runDesktopHost(sdk, async ({ startBackend }) => {
  // Set application native capabilities before startup callbacks run.
  const { backend } = await startBackend();
  await createApplicationNativeController({ sdk, backend });
});
```

The wrapper chooses source or packaged `app.js`, resolves data storage, handles
supervisor readiness and drains the backend on setup failure, process signals
and non-vetoed SDK quit events. It never constructs a window. Existing native
quit vetoes are respected; closing a window does not itself stop the backend.
`startBackend({ dataDir })` accepts an application-owned absolute storage path.
Only one backend may be started. Await startup inside the callback.

The backend provides `origin`, `bootstrapOrigin`, `stop()` and
`createWindowUrl(destination?)`. Create a fresh bootstrap for each opened native
window or OS browser; it is single-use and can target only the application origin.
At most one unspent bootstrap is active, so minting another invalidates the prior
one. Keep navigation sandboxed and restricted to these two origins, and call
`stop()` when quitting. Closing only a window may leave the backend running.

The native host owns menus, native events, updates and explicit test-script
injection. It may use the private `cookie` for in-process requests or an owner-only
native helper descriptor; never log or serialize it into browser data. SSR loaders
that call the HTTP API must forward the incoming request cookie only to the same
application origin. The default host never exposes the cookie.

The lower-level `startDesktopBackend` and development context remain available.
Custom hosts also support `dev`. After importing the SDK, call
`getDesktopDevelopment()` from `@teyik0/furin-electrobun/host`. When present,
import its `serverEntry` instead of the packaged artifact and pass `"dev"` to
`startDesktopBackend()`. Construct your native controller, then call
`await development.ready(backend, shutdown)`, where `shutdown` drains the backend
and quits through the SDK. The context restores the consuming root as CWD and
handles supervisor control and readiness; it is absent in packaged builds.

Custom development keeps the backend and native SDK in one managed Bun process,
so native APIs share the application runtime without a new RPC transport. The
supervisor starts it with the consuming `bunfig.toml`, preserving frontend
plugins and public environment filtering. Frontend-only edits retain the window
and use Furin Fast Refresh. Backend or host dependency edits drain the old host, rebuild the
SDK entry and open a replacement window; durable state survives, while unsaved
React state across a backend restart is not promised. The default host keeps
its separate helper workflow. This follows the frontend/state distinction in
[Next.js Fast Refresh](https://nextjs.org/docs/architecture/fast-refresh); using
Bun server `--hot` alone would also replace native SDK module identities.

`furin-electrobun build --env=dev` packages a development identity; the build output
is still production output with session protection. Omit the flag for stable SDK
packaging. No stable package publication is implied.

PR previews publish core and Electrobun together using Bun packing to resolve
workspace/catalog references. Repository-qualified preview URLs avoid compact
name ambiguity. Fresh consumers should verify a frozen installation of both.

## Architectural decision

The recommended approach is an inert Furin server artifact, hosted in-process
by the SDK. A second backend process simplifies development isolation but adds
production memory, process supervision and another lifecycle. Bundling the
whole Furin app into the SDK entry appears simpler but duplicates build/AOT
ownership and makes resource relocation and native dependencies brittle.
Neither alternative is used for production.

Creating the Elysia root through the package factory is the deliberate backend
integration seam. It needs a constructor/import change, but preserves the web UI
and Elysia lifecycle without changing Elysia itself. A private-socket backend plus
HTTP/WebSocket proxy could enforce a separate boundary, but adds transport,
backpressure and platform-specific IPC work that this integration does not need.

[Next.js standalone output](https://nextjs.org/docs/app/api-reference/config/next-config-js/output)
traces a deployable server closure, while
[TanStack Start deployment](https://tanstack.com/start/latest/docs/framework/react/guide/hosting)
uses server artifacts and hosting adapters. Furin already has a Bun artifact
and Elysia lifecycle; reusing those contracts is smaller and more maintainable
than introducing another server DSL or an SDK dependency into core.

## Package development

```sh
bun run test
bun run tscheck
bun run fix
bun run build
```

Headless tests cover configuration, safe initialization, full artifact copying,
version-preserving external dependency closure, real in-process Elysia HTTP
requests on port `0`, session bootstrap and idempotent cleanup. GUI validation
is separate and must be performed by someone allowed to launch native apps.

The factory integration was also verified in a real macOS WKWebView session:
unauthenticated API calls returned `403` before and after restart, authenticated
UI CRUD succeeded, JSX/CSS updates preserved the draft and document, and backend
restart preserved a task while replacing and reaping the native host. That
validation used the original application root, not a test-only parent remount.
Windows and Linux native behavior require their own platform verification.

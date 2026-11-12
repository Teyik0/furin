# Native host ownership

The generated bootstrap imports the canonical devkit of the installed Electrobun release and starts the controller internally. The separately bundled Furin `app.js` remains inert until loaded. A native module selected by `desktop.build.bun.entrypoint` registers original SDK integrations; it does not launch the app. The principal window is declared exclusively in `.use(desktopApp({ window: { ... } }))` on the Elysia root.

The shared cross-bundle registry exposes the live native controller through `getDesktopHost()` and a serializable, asynchronous Elysia controller through the named `desktopContext` provider. Both modes share one command executor: a packaged app calls it in-process, development reaches it over the shell channel. Each request resolves the controller at execution time, so independent API modules can be imported before native installation. The provider does not register roots or native resources. The functional root plugin returns Elysia's inferred provider type and preserves route/Eden inference. No ambient context augmentation is used.

## Startup and shutdown

The host resolves SDK identity and runtime storage before claiming single-instance ownership. Launch inputs and inputs forwarded by secondary instances are delivered through the original SDK's `open-url` event after readiness; files use `file:` URLs. Native modules subscribe directly with `Electrobun.events.on("open-url", handler)`. Direct OS events follow the SDK lifecycle; application startup dependencies and asynchronous handler ordering are application-owned. Furin reads only the native module's `defineNative` default export and provides no `onOpen` callback.

The host loads the app and optional native integrations, installs session guards, awaits Elysia modules and every `.onStart()` hook, then creates main using the original SDK constructor. Elysia's successful listen callback is the readiness boundary. No window opens after failed or cancelled startup. `desktop.open()` throws before readiness instead of queueing a promise that could deadlock initialization.

Application resources use Elysia `.onStart()`/`.onStop()`. Initialize resources during startup so Elysia owns their cleanup; cleanup does not execute for a root that never started. Request errors use `.onError()`. Native SDK events run outside HTTP and must catch synchronous errors and rejected promises themselves.

Quitting aborts startup, drains the backend once under a five-second shutdown deadline, fences and closes all managed windows, releases single-instance ownership and calls SDK quit. Restart arms the native relaunch helper before coordinated shutdown. Update installation drains the backend before SDK handoff and guards concurrent quit/restart. Failed update handoff offers an error dialog and coordinated restart. Main close follows `background()` policy; additional windows keep the app alive until the last managed window closes. Original SDK trays are application-owned and are removed on final host shutdown.

## Windows and SDK identity

In native modules, `getDesktopHost().window` is a readonly current getter for the original `BrowserWindow | undefined`, and `windows.create(name, { path, ...sdkOptions })` returns the original SDK `BrowserWindow<T>` with exact RPC inference. In Elysia, `desktop.window` and `desktop.windows` expose the SDK's serializable window methods as promises; options exclude RPC. `desktop.native` calls the native entrypoint's `defineNative` default export, typed through a generated declaration. Raw SDK windows/views remain available independently.

Furin manages URL, HTML, views root, protocol and navigation boundaries. Runtime overrides protect those fields even if JavaScript passes structurally wider options. Other SDK options pass through. RPC enables the native transport unless explicitly sandboxed; without RPC, sandbox defaults on. Trusted native code retains all original SDK methods and can deliberately change a window later.

SDK value imports belong in native modules. The generated host and those modules resolve to the same devkit paths, including every public `electrobun/main/*` subpath. Shared server/web modules use desktop context and type-only SDK imports. Bundling a second SDK into the application artifact would create independent constructor/maps/events and is outside this contract.

## Listener and authentication

The root plugin installs admission ahead of application wrappers and disables native static response promotion. Native HTMLBundle routes bypass application dispatch and are rejected, except the dev-only Furin GET HMR entry. Custom adapters and `serve.routes` are rejected. The native backend uses the original Elysia root rather than forwarding through a second Elysia graph.

Loopback and in-process dispatch are distinct. Eden/app.handle calls stay in process; listener calls are marked using Bun's actual server argument and checked before application dispatch, including compiled/AOT builds. `admission(request, facts)` can authenticate external traffic without trusting headers for peer identity. Facts include verified desktop session and the TCP peer reported by Bun. `restrictWebToLoopback` optionally constrains ordinary web listeners too.

Managed windows use the application's listener hostname, scheme and port. Wildcard addresses map to their local destination (`0.0.0.0` to `127.0.0.1`, `::` to `[::1]`); explicit hostnames are preserved. Unix sockets cannot provide a WebView HTTP(S) destination.

Each HTTP managed window receives a fresh, one-use bootstrap token and HttpOnly/SameSite cookie on a separate ephemeral listener bound to the same hostname as the window destination. Matching hostnames keep the cookie valid across the bootstrap redirect, including for IPv6 and LAN listeners. The backend verifies origin, cookie and navigation provenance. Tokens expire and are bounded; paths cannot leave the app origin. The bootstrap stays bound until backend cleanup finishes to prevent port reuse during draining. Browser-open uses its own token.

TLS windows receive a verified HttpOnly/Secure/SameSite cookie through the original SDK Session before navigation. SDKs that cannot preserve the required cookie attributes fail closed. A system browser cannot receive this native TLS session; `browser.open` returns false for that listener. Main and additional windows share the secured application session while using independently issued navigation tokens.

## Packaging and development

Compatible configuration derives from original SDK types. Furin owns the generated Bun entry, inert app artifact, helper destinations and runtime exit policy. CEF/WGPU default off; explicit per-platform opt-ins are preserved. CEF renderer selection requires that platform's CEF assets. Copy sources, view entrypoints, native entrypoints, scripts and icons resolve from the consuming project; output folders remain inside the generated SDK project. Required app/runtime assets and external native dependencies remain relocatable with the artifact.

The npm package is a launcher. `furin-electrobun prepare` projects the SDK of the installed launcher (peer range `~2.0.2`) and generates exact TypeScript aliases from its export map. Extend `.furin/electrobun/tsconfig.json`; rerun preparation after relocation. Published declarations use SDK specifiers and contain no machine-specific SDK path. Package development prepares the devkit of its installed launcher and applies type-only annotations needed to emit the SDK's inferred private Session types; consumer native code remains the original SDK.

Development splits the backend from the native shell. Furin's `bun --hot` worker owns the Elysia backend, its session cookie and an authenticated loopback channel; it launches the Electrobun shell once. The shell mints one-use window URLs with a key received over that channel, and the backend redeems them on its own origin. Backend edits reload in place without touching the shell; changes to the native entrypoint's import graph rebuild and relaunch only the shell. Closing the channel quits the shell, forcibly after five seconds. The Bun preload activates only for the configured `--hot` server entry and hands off to `furin dev`. Ordinary web mode, imports and tests do not initialize the SDK.

## Runtime storage and associations

`dataDir` accepts an absolute override or `{ name, developmentName, env? }`. The launching user resolves HOME/APPDATA and the optional override. SDK channel `dev` selects the development name. Source relative overrides use the project root; packaged relative overrides use launch CWD. Development aliases into the release data tree are rejected. The host shares the resolved path with ownership, forwarding and backend setup; application data is never moved during packaging.

`protocols` explicitly registers application-private schemes on Windows/Linux and must be a subset of declared `app.urlSchemes`. Shared schemes are not silently made defaults. SDK packaging handles macOS associations. `desktop.associations` retains explicit read/request-default helpers where platform registration needs user action.

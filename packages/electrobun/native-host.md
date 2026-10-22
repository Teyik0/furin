# Standard native host

The generated entry is a small bootstrap importing the canonical Electrobun
2.0.2 Bun SDK and the internal host controller. The application artifact remains
separate; the host does not bundle a second Elysia graph or create a new RPC API
for business routes. `build.bun.entrypoint` optionally selects a native
customization module loaded before the server, without any host launch call.

## One development command

```json
{
  "scripts": {
    "dev": "bun --hot src/server.ts",
    "build:desktop": "furin-electrobun build"
  }
}
```

Register the launcher once in `bunfig.toml` (the desktop initializer does this):

```toml
preload = ["@teyik0/furin-electrobun/preload"]
```

With `desktop` configured, that exact Bun command opens native and browser
documents on one secured backend, database and service owner. No launch function
or new branch is required in the server. The preload awaits the supervisor before
the entry can execute, so only the SDK process imports and initializes the app.
It activates only for `--hot` and the configured `serverEntry`; ordinary imports,
tests, builds, unrelated hot entries and the managed SDK do not launch desktop.

`furin dev` remains an optional explicit launcher. Its `--desktop` option opens
only native; `--web` runs a server without the SDK. `--port` applies only to that
web mode. The source entry can call `.listen()` and register Elysia `onStop`
cleanup directly, without a default export. `desktopApp()` installs the native
runtime and session protection before listening. After Elysia's listen callback
and application `onReady`, the plugin requests its native window; the generated
host fulfills that request once native setup finishes. Inert default
exports remain supported and are used by Furin's production app artifact.
Startup errors are printed before cleanup and SDK `quit(1)`, so an immediate
native exit preserves the original cause in development diagnostics.

## Configuration and lifecycle

Keep static packaging in `furin.config.ts`:

```ts
desktop: defineDesktopConfig({
  app: { name: "Example", identifier: "app.example.desktop", urlSchemes: ["example"] },
  window: { width: 1200, height: 800 },
  tray: {
    mac: { image: "public/tray-template.png", template: true },
    win: { image: "public/icon.png" },
    linux: { image: "public/icon.png" },
  },
  protocols: ["example"],
})
```

Tray paths resolve from the application root in source dev, and from the copied
Furin artifact in packages. `protocols` explicitly registers app-private
schemes on Windows/Linux; it must be a subset of declared SDK schemes.
Shared schemes such as `magnet` are **not** implicitly made system defaults.
macOS registration remains owned by SDK packaging.

### Runtime storage before startup

Static absolute `dataDir` strings remain supported. To keep an existing
user-relative location, declare a policy instead of calling `homedir()` in
build configuration:

```ts
dataDir: {
  name: "Example",
  developmentName: "Example-dev",
  env: "EXAMPLE_DATA_DIR",
}
```

The launching user determines HOME/APPDATA and the optional override. macOS
uses `Library/Application Support`, Linux `.local/share` (this named-location
policy deliberately does not switch historical data to XDG_DATA_HOME), and
Windows APPDATA with the existing `AppData/Roaming` home fallback. Names must
be directory components and different between release and dev. SDK channel
`dev`, not NODE_ENV or build-time environment, selects the development name.
Relative source overrides use the actual project root; packaged overrides
use launch CWD. Canonical release-tree aliases are rejected for dev.

Omission retains the identifier-based SDK default. Resolution is read-only;
normal startup creates only the selected directory and its ownership metadata.
The resolved path is shared by the native lease, forwarding and backend. Profile
markers, migrations and checks against legacy processes remain app responsibilities.
Do not try to resolve the host directory in `onStartup`: ownership already exists
then. Advanced hosts can call `resolveDesktopDataDir` from the host entrypoint.

The serializable policy fits the existing `furin-host.json` contract. A runtime
configuration module would allow arbitrary logic but adds an entry, packaging
and watching responsibilities; it is unnecessary for named directories and an
environment override. Like [Next.js runtime environment variables](https://nextjs.org/docs/app/guides/environment-variables)
and [TanStack Start server environment](https://tanstack.com/start/latest/docs/framework/react/guide/environment-variables),
launch values are read in the runtime, not frozen in build configuration. Here
resolution occurs once before instance ownership, rather than per HTTP request.

Runtime callbacks belong on the original server root:

```ts
new Elysia()
  .use(desktopApp({
    async onStartup({ signal, runtime }) {
      await services.open({ signal, runtime });
    },
    async onReady({ runtime, backend }) {
      await services.activate({ runtime, origin: backend.origin });
    },
    onShutdown() {
      return services.close();
    },
    background: () => services.settings.runInBackground,
    async onOpen({ event, desktop }) {
      await services.openNativeInput(event);
      desktop.window.open();
    },
    tray: ({ desktop }) => [
      { label: "Open", onSelect: () => desktop.window.open() },
      { label: "Open in browser", onSelect: () => desktop.browser.open("/") },
      { type: "divider" },
      { label: "Quit", onSelect: () => desktop.quit() },
    ],
  }))
  .use(api);
```

`runtime` discriminates `{ kind: "server" }` from
`{ kind: "desktop", identity, desktop }`. Native identity comes from the SDK,
not `NODE_ENV`. Native dialogs, shell, notifications and updater exist before
service startup. Window/browser actions require completed backend readiness.
Shutdown callbacks must tolerate partial initialization and cooperate with
aborted signals. Do not open a listener in a startup hook.
The standard host publishes development readiness and shutdown failure records;
application `onReady` hooks only activate their services/descriptors. They do not
call `getDesktopDevelopment()` or manage supervisor control files. Packaged
SIGINT/SIGTERM also converge on the same idempotent `desktop.quit()` cleanup.

## Capabilities

- `window.open()` shows/activates the existing window or recreates it with a new
  bootstrap. `window.background()` requests closing after its HTTP response can
  be delivered. It refuses without an enabled policy and SDK-visible tray.
- `snapshot()` reports phase, owned window count, SDK WebView count, background
  state and SDK tray visibility. SDK visibility is not an independent monitor
  of every Linux desktop shell.
- `browser.open(destination?)` creates a fresh local bootstrap then delegates
  to `Utils.openExternal`. Destinations cannot escape the app origin.
- `shell.openExternal`, `openPath`, `showItemInFolder`, `dialogs.message`,
  `dialogs.selectDirectory` and `notifications.show` use public SDK utilities.
  Folder cancellation returns `null`.
- `menus` supplies native application menu items and roles. Default application
  and Edit menus use SDK roles. Application menus are unavailable on Linux;
  keep essential actions in UI/tray. Menu handlers may be asynchronous.
- `updates.check`, `download`, `install`, `snapshot`, `subscribe` delegate to the
  SDK updater. Subscription disposal does not remove other app subscribers.
- `restart()` releases application/native ownership, quits through the SDK and
  launches a new native application only after the old runtime and launcher exit.
  The resolved data directory and launch environment are retained, not UI state.

## Incoming events and single-instance handoff

The host captures SDK `open-url` before awaiting config/application loading and
delivers normalized URL/file events sequentially after service readiness.
One rejection does not poison later events. `FURIN_NATIVE_OPEN` is consumed for
cold helper launch, and native `reopen` shows the existing window.

A kernel-backed per-data-directory lease prevents a second native service owner.
The package's helper forwards only registered open events or activation to the
active instance, never arbitrary HTTP routes. Its separate loopback listener
requires an independent credential from an owner-only descriptor under
`.furin-native/`: POSIX directory/file modes or a current-user Windows DACL.
No backend session cookie or OAuth URL is put in logs. This is not a sandbox
against hostile processes running as the same OS user.

macOS receives associated files as `file://` URLs from SDK events. Windows/Linux
private protocol registration uses the packaged generic helper. No application
OAuth-specific helper is required; authorization and torrent rules stay in app code.

## Default applications

`associations.read(target)` and `requestDefault(target)` return explicit
`confirmed`, `user-action-required`, or `unsupported` results.

- macOS uses Launch Services and verifies the returned default after a change.
- Windows opens the system default-app UI rather than forging protected
  UserChoice defaults. Reads report native ProgIDs.
- Linux uses XDG tools and confirms the chosen desktop entry. File extensions
  additionally need `mimeType`; a bare extension cannot reliably infer a MIME.
- Development builds cannot request shared system-default changes.

Changing defaults is an explicit user action, never part of normal startup.

## Native updates

SDK owns download verification, patching, post-exit replacement and binary rollback.

Install pauses dispatch and closes services before permitting SDK quit approval.
Successful handoff lets the SDK launch the new version. On a reported error,
exception or cancelled handoff, the host shows a native error dialog and calls
`restart()`. There is no `state.recover` or old-process reinitialization.

Packaged restart arms a transient helper before quitting. It pins kernel process
identities (macOS kqueue, Linux pidfd, Windows process handles), waits for both
the main runtime and `ELECTROBUN_LAUNCHER_PID`, then runs the packaged native
launcher. Application cleanup releases the data lease; native shutdown releases
the instance lease. No Worker or direct app-script execution replaces the SDK.
The environment is handed off over a temporary authenticated loopback listener
and is never serialized to a restart file. Already-consumed native URLs and old
launcher PID metadata are not replayed. The helper refuses to launch if shutdown
does not complete within thirty seconds.

Windows uses a current-user-only transient scheduled task to escape the old
application's Job Object, then deletes the task after readiness. Task Scheduler
must be available. Linux requires kernel 5.3+ and glibc. In source development,
the existing supervisor reaps the old SDK process before launching its replacement.
Shutdown retains its five-second cleanup deadline. If arming restart fails,
the error is reported; it never falls back to old-process service recovery.

The `dev` SDK channel does not offer native updates. Validate an installed stable
or canary build. Post-exit binary rollback remains SDK-owned.
Headless launcher tests validate process ordering and lease release; actual GUI
and native update installation require separate platform validation. Windows
scheduled-task integration tests require `FURIN_NATIVE_RESTART_TEST=1`.

## Opt-in native tests

`FURIN_NATIVE_TEST_SCRIPT=/absolute/path/to/script.js` loads an explicit script.
Relative paths resolve from the project root in source development and from
launch CWD in packaged runs. No application-specific aliases are interpreted.
It runs at `dom-ready` on each newly created document, including reopened windows.
No script is injected by default. Scripts and temporary test state are app-owned.

Headless tests exercise real backend HTTP and SDK-boundary fixtures. Windows/Linux
registration, GUI/tray interaction and real native update handoff require their
own platform validation; a passing headless test does not establish that evidence.

## SDK authority

This implementation follows documentation pinned to
[Electrobun v2.0.2](https://github.com/blackboardsh/electrobun/tree/v2.0.2/docs/src/content/docs/electrobun):
BrowserWindow, Tray, ApplicationMenu, Events, Utils and Updater. `before-quit`
is synchronous: veto first, persist asynchronously, then retry quit. Furin
does not reimplement native UI, SDK patching or its replacement helper.

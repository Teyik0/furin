# Standard native host

The generated entry is a small bootstrap importing the canonical Electrobun
2.0.2 Bun SDK and `runStandardDesktopHost`. The application artifact remains
separate; the host does not bundle a second Elysia graph or create a new RPC API
for business routes. `hostEntry` remains an advanced alternative.

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
web mode. Export an inert Elysia root; keep any existing manual source `listen()`
guarded with `import.meta.main`.

## Configuration and lifecycle

Keep static packaging in `furin.config.ts`:

```ts
desktop: defineDesktopConfig({
  app: { name: "Example", identifier: "app.example.desktop" },
  window: { width: 1200, height: 800 },
  tray: {
    mac: { image: "public/tray-template.png", template: true },
    win: { image: "public/icon.png" },
    linux: { image: "public/icon.png" },
  },
  protocols: ["example"],
  sdk: { app: { urlSchemes: ["example"] } },
})
```

Tray paths resolve from the application root in source dev, and from the copied
Furin artifact in packages. `protocols` explicitly registers app-private
schemes on Windows/Linux; it must be a subset of declared SDK schemes.
Shared schemes such as `magnet` are **not** implicitly made system defaults.
macOS registration remains owned by SDK packaging.

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

Furin coordinates **service** generations; SDK owns download verification,
patching, post-exit replacement and binary rollback.

Install pauses authenticated app dispatch, aborts/drains the current services,
and permits the SDK's synchronous quit approval only after cleanup. A reported
helper error, rejected handoff or cancelled approval reopens services and awaits
`onReady` while retaining the same listener/session. Recovery has a thirty-second
deadline. Normal shutdown has a five-second deadline.

The `dev` SDK channel does not offer native updates. Validate an installed stable
or canary build. Recovery within the old process is possible only before it exits;
post-exit replacement recovery is SDK-owned.

## Opt-in native tests

`FURIN_NATIVE_TEST_SCRIPT=/absolute/path/to/script.js` loads an explicit script.
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

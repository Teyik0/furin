# Tofu migration to the standard host

This is a migration guide, not a modification of the Tofu checkout.

## Prerequisite: upgrade to Furin 0.8

This package peers on `@teyik0/furin >=0.8.0-alpha.0 <0.9.0`. Tofu still pins
Elysia `2.0.0-beta.21` and vendored pre-0.8 snapshots, so migrate the
application to the merged core before switching hosts:

- Elysia `2.0.0-beta.32` (the workspace catalog) renames lifecycle methods:
  `.setup()` → `.onStart()`, `.cleanup()` → `.onStop()`, `.request()` →
  `.onRequest()` (for example `src/api/index.ts` and `updates/plugin.ts`).
- `createClient(app)` is removed. Use `treaty(app).use(furinSync).api` from
  `@elysia/eden` and `@teyik0/furin/client`; retries move to `useMutation({ retry })`.
- Pages name their route: `defineRoute("/path")`. The parent layout is inferred
  from the file tree, so drop `config({ layout })`.
- Sync identifies GET reads by URL: remove `sync: { id, scope }` from GET routes.
  A mutation invalidates the GET at its own URL; replace
  `sync: { invalidate: ... }` with `invalidate(pattern, params)` or
  `invalidate({ path, type })` called from the handler, before a `mutation()`
  callback returns.
- A mutation without `Idempotency-Key` now commits with a server-generated key
  instead of returning 428.

## Preserve historical storage

Keep Tofu's existing build-time identity, packaging, protocols and icons, remove
the custom `build.bun.entrypoint` when using the standard host, and add this literal policy inside `desktop: defineDesktopConfig(...)`:

```ts
dataDir: {
  name: "Tofu",
  developmentName: "Tofu-dev",
  env: "TOFU_DATA_DIR",
},
```

Do not evaluate `homedir()` or `TOFU_DATA_DIR` in `furin.config.ts`. At launch
this yields the existing paths:

| Platform | Release | SDK dev channel |
| --- | --- | --- |
| macOS | `~/Library/Application Support/Tofu` | `~/Library/Application Support/Tofu-dev` |
| Linux | `~/.local/share/Tofu` | `~/.local/share/Tofu-dev` |
| Windows | `%APPDATA%/Tofu` | `%APPDATA%/Tofu-dev` |

Windows without APPDATA uses `~/AppData/Roaming`. A launch-time `TOFU_DATA_DIR`
override takes precedence. Relative source overrides resolve from the actual
project root, matching the backend's CWD; packaged overrides retain launch-CWD
resolution. Nothing is migrated, replaced or deleted. Keep Tofu's own profile
marker, legacy-instance checks and download-directory policy.

## Remove bootstrap workarounds

- Delete `src/desktop-host.ts` once parity gates pass: the generated host uses the
  canonical Hutch SDK and obtains metadata before changing development CWD.
- Remove `TOFU_MODE = "desktop"` from native boot; services already receive the
  typed desktop runtime. Retain server-mode behavior where Tofu still needs it.
- Remove manual data-directory option calculation and development chdir. Tofu can
  keep its domain resolver's `FURIN_APP_DATA_DIR` consistency assertion.
- Remove `getDesktopDevelopment()`, `developmentHosts`, the `DesktopBackend` cast
  and `development.ready(...)` branch from application `onReady`. Keep activation
  and `writeServerInfo(...)`; Furin owns native/dev readiness and shutdown reporting.
- Remove custom SIGINT/SIGTERM registration; the standard controller owns those.
- Remove test-script loading from the host. Tofu's smoke launchers may explicitly
  pass `FURIN_NATIVE_TEST_SCRIPT: process.env.TOFU_SMOKE_SCRIPT`; Furin deliberately
  does not recognize `TOFU_SMOKE_SCRIPT` itself.

## Migration checklist

1. Keep the original Elysia root and ordinary `.use(apiPlugin)` composition.
2. Remove `build.bun.entrypoint` after moving runtime policies to `desktopApp`.
3. Keep `dev` as `bun run codegen && TOFU_PROFILE=dev bun --hot src/server.ts`.
   Register `@teyik0/furin-electrobun/preload` in the top-level Bun preload array,
   preserving existing `[serve.static]` plugins. No launch function is added to
   the server. Keep setup under `predev`, including addon/worker preparation.
   The supervisor restarts the backend when `runtime/engine-worker.worker`
   changes, but it cannot see the worker's sources behind that prebuilt asset:
   run an application-owned watcher that rebuilds it (for example `Bun.build`
   with `watch` over `src/api/modules/torrents/worker.ts`) next to `bun run dev`.
4. Replace `onStartup(signal)` with `onStartup({ signal, runtime })`.
   Pass that runtime into `openCoreApplication` instead of reading a global
   `tofuNativeSdk`. Resolve profile from SDK channel/identity in desktop mode;
   retain Tofu's explicit server-mode profile selection.
5. Resolve instance configuration during startup, not from an eager global native
   SDK import. Keep existing data locations via `desktop.dataDir`; do not silently
   migrate databases to a new identifier-based default.
6. Keep ApplicationHost's startup/shutdown ownership. `onReady` activates the full
   application with its runtime after worker/database checks. Business API remains
   unavailable until that activation.
7. `background()` reads the saved `runInBackground` setting. Failed update
   handoff restarts the whole native application, not a new generation in the old VM.
8. Tray/menu callbacks call the supplied desktop controller. Keep only the
   torrent/AniList interpretation of incoming `OpenEvent` in the application.
   Preserve file-size checks, OAuth state checks and repeated paused-torrent behavior.
9. Replace desktop SDK imports/types with public Furin capabilities in backend
   routes and update service integration. Furin owns shutdown and native relaunch
   and the native quit approval; Tofu still owns release selection and notification policy.
10. Remove the custom DesktopController, DesktopUpdateInstaller, protocol
    forwarding helper and generic macOS FFI adapter after native parity tests pass.
    Keep the Tofu-only default-association action and its release restriction.
11. Add private `protocols: ["tofu"]` or `["tofu-dev"]` alongside SDK declarations.
    Add `mimeType: "application/x-bittorrent"` to the `.torrent` file association.
    At startup Windows and Linux list Tofu as a handler for `.torrent` and
    `magnet` without changing defaults; becoming the default stays a
    user-requested action (on Windows, through the app's Default Apps page).
12. Remove the old protocol helper from resource generation and SDK copy entries.
    Keep worker/addon preparation, public icons, license, AniList client metadata
    and release artifact policy.
13. Forward native failures (open events, menu actions, update listeners, quit)
    from `desktopApp({ onError })` to Tofu's sanitized `recordLog`. The error is
    unredacted and can contain OAuth URLs.
14. Switch opt-in smoke injection to `FURIN_NATIVE_TEST_SCRIPT`. Adapt test helper
    access to the standard instance transport; retain any app-specific diagnostic
    descriptor in `onReady` if needed, without exposing it to browser loaders.

## Keep the isomorphic Eden client

Keep the server-side `treaty(apiPlugin).use(furinSync).api` and browser-side
`treaty<Api>(window.location.origin, { fetch: { cache: "no-store",
credentials: "include" } }).use(furinSync).api`. Here `apiPlugin` is the same final application
that listens, not a second active router.

The server client calls `app.handle()` without network dispatch. Furin permits
these trusted in-process reads and mutations without a cookie; SSR loaders use
the same application. The browser still sends real HTTP requests and must pass
session and origin checks. Neither `http://e.ly` nor a header identifies internal
calls. Startup, update pause and shutdown block both paths.

Remove the provisional vendored guard workaround when using this upstream fix.
Do not add cookie forwarding or replace internal Eden calls with HTTP fetches.
Application authorization remains Tofu-owned; possession of an application
reference is a trusted in-process capability, not a sandbox boundary.

Parity gates before deleting the old host:

- startup failure leaves no engine, DB or profile lease;
- native and browser documents share one engine and sync stream;
- native window close/background/reopen preserves a real transfer and bytes;
- source TSX/CSS refresh preserves draft/document/native PID;
- backend/host restart reaps the previous owner and restores persisted transfers;
- cold/warm torrent, magnet and OAuth events reach the correct dev/release instance;
- dev cannot claim release data/default associations;
- explicit native update handoff failure closes services and releases both the
  Tofu data lease and native instance lease before a fresh process becomes ready;
- replacement runtime and launcher PIDs differ; persisted transfers remain
  available through a new authenticated session, never an old-process recovery;
- each recreated document receives the opt-in smoke script, never normal launches.

Use temporary state and real peer fixtures. Do not change the user's system-default
application as part of ordinary tests. Actual native GUI/registration tests need
separate validation on macOS, Windows and Linux.

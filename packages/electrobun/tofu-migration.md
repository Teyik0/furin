# Tofu migration to the standard host

This is a migration guide, not a modification of the Tofu checkout.

1. Keep the original Elysia root and ordinary `.use(apiPlugin)` composition.
2. Remove `hostEntry` after moving runtime policies to `desktopApp`.
3. Keep `dev` as `bun run codegen && TOFU_PROFILE=dev bun --hot src/server.ts`.
   Register `@teyik0/furin-electrobun/preload` in the top-level Bun preload array,
   preserving existing `[serve.static]` plugins. No launch function is added to
   the server. Keep setup under `predev`, including addon/worker preparation.
4. Replace `onStartup(signal)` with `onStartup({ signal, runtime })`.
   Pass that runtime into `openCoreApplication` instead of reading a global
   `tofuNativeSdk`. Resolve profile from SDK channel/identity in desktop mode;
   retain Tofu's explicit server-mode profile selection.
5. Resolve instance configuration during startup, not from an eager global native
   SDK import. Keep existing data locations via `desktop.dataDir`; do not silently
   migrate databases to a new identifier-based default.
6. Keep ApplicationHost's domain generations. `onReady` activates the full
   application with its runtime after worker/database checks. Business API remains
   unavailable until that activation.
7. `background()` reads the current generation's saved `runInBackground`.
   Do not capture a retired engine: update recovery creates a new generation.
8. Tray/menu callbacks call the supplied desktop controller. Keep only the
   torrent/AniList interpretation of incoming `OpenEvent` in the application.
   Preserve file-size checks, OAuth state checks and repeated paused-torrent behavior.
9. Replace desktop SDK imports/types with public Furin capabilities in backend
   routes and update service integration. Furin owns service preparation/recovery
   and the native quit approval; Tofu still owns release selection and notification policy.
10. Remove the custom DesktopController, DesktopUpdateInstaller, protocol
    forwarding helper and generic macOS FFI adapter after native parity tests pass.
    Keep the Tofu-only default-association action and its release restriction.
11. Add private `protocols: ["tofu"]` or `["tofu-dev"]` alongside SDK declarations.
    `magnet` remains a user-requested default, not automatic registration.
12. Remove the old protocol helper from resource generation and SDK copy entries.
    Keep worker/addon preparation, public icons, license, AniList client metadata
    and release artifact policy.
13. Switch opt-in smoke injection to `FURIN_NATIVE_TEST_SCRIPT`. Adapt test helper
    access to the standard instance transport; retain any app-specific diagnostic
    descriptor in `onReady` if needed, without exposing it to browser loaders.

Parity gates before deleting the old host:

- startup failure leaves no engine, DB or profile lease;
- native and browser documents share one engine and sync stream;
- native window close/background/reopen preserves a real transfer and bytes;
- source TSX/CSS refresh preserves draft/document/native PID;
- backend/host restart reaps the previous owner and restores persisted transfers;
- cold/warm torrent, magnet and OAuth events reach the correct dev/release instance;
- dev cannot claim release data/default associations;
- explicit native update handoff failure restores service/API readiness without
  dropping the original HTTP session;
- each recreated document receives the opt-in smoke script, never normal launches.

Use temporary state and real peer fixtures. Do not change the user's system-default
application as part of ordinary tests. Actual native GUI/registration tests need
separate validation on macOS, Windows and Linux.

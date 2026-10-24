# Application integration notes

Use the original Electrobun APIs in an optional native module and Furin's controller for coordinated application operations. See [the public API](./README.md) and [host ownership](./native-host.md).

The Elysia root declares main with `desktopApp({ window: { title, frame, ...sdkOptions } })`. Independent API plugins install `desktopContext`; native modules call `getDesktopHost()`. Both receive the same live controller. SDK menus, tray, dialogs, notifications, shortcuts, screens, sessions, views, RPC and GPU capabilities remain available through `electrobun/main` and its original public subpaths.

Application data/profile initialization and disposal belong to Elysia `.onStart()` and `.onStop()`. Keep dependent startup steps in one async hook. Native events must handle their own errors. Replace Furin `onOpen` callbacks with `Electrobun.events.on("open-url", handler)` in `desktop.build.bun.entrypoint`; the original SDK payload is `event.data.url`, including `file:` URLs. Furin forwards launch and secondary-instance inputs through this event after readiness. Background policy, association helpers and coordinated quit/restart/update installation remain Furin responsibilities.

For existing data directories, declare a runtime `dataDir` policy; resolve user environment at launch, not during packaging. Existing profile markers, business input handling and data migrations remain application-owned. No application source in the reference Tofu checkout is modified by this integration.

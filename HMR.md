# HMR Architecture - Elysion Framework

## Validated Architecture (poc-hmr-v2)

The HMR system was validated in `poc-hmr-v2/`. It provides React Fast Refresh with state preservation using Bun's runtime, Elysia WebSockets, and Babel transforms.

### How It Works

```
┌─────────────────────────────────────────────┐
│  Server (bun --hot server.tsx)              │
├─────────────────────────────────────────────┤
│                                             │
│  1. File Watcher (fs.watch)                 │
│     - Watches pagesDir recursively          │
│     - Debounces duplicate macOS events      │
│     - Invalidates module transform cache    │
│     - Broadcasts update via WebSocket       │
│                                             │
│  2. WebSocket Server (/__hmr)               │
│     - Maintains Set<WebSocket> of clients   │
│     - Sends { type, path, modules }         │
│                                             │
│  3. Module Transform (/_modules/pages/*)    │
│     - Reads raw file with Bun.file().text() │
│     - Babel: TSX → JS + React Refresh       │
│     - Strips React imports, injects globals │
│     - Wraps with scoped $RefreshReg$        │
│     - Caches in Map, invalidated on change  │
│                                             │
│  4. Client Bundle (/__client.js)            │
│     - Bun.build() of client-entry.ts        │
│     - Contains: React, ReactDOM,            │
│       React Refresh runtime, HMR client,    │
│       hydration logic                       │
│                                             │
│  5. Refresh Setup (/__refresh-setup.js)     │
│     - Creates __REACT_DEVTOOLS_GLOBAL_HOOK__│
│     - Must load BEFORE React DOM            │
│                                             │
└───────────────┬─────────────────────────────┘
                │ WebSocket
                ▼
┌─────────────────────────────────────────────┐
│  Browser                                    │
├─────────────────────────────────────────────┤
│                                             │
│  1. Load /__refresh-setup.js (sync script)  │
│     → Creates devtools hook for renderer    │
│                                             │
│  2. Load /__client.js (module script)       │
│     → Expose window.React, window.ReactDOM  │
│     → RefreshRuntime.injectIntoGlobalHook() │
│     → Setup global $RefreshReg$/$RefreshSig$│
│     → Connect WebSocket to /__hmr           │
│     → Import page module /_modules/pages/*  │
│     → hydrateRoot() + keep root reference   │
│                                             │
│  3. On file change (WebSocket message):     │
│     → moduleVersion++                       │
│     → import(url + "?v=" + version)         │
│     → New module registers via $RefreshReg$ │
│     → performReactRefresh() patches in-place│
│     → State preserved!                      │
│                                             │
│  4. Fallback (if Fast Refresh fails):       │
│     → root.unmount()                        │
│     → createRoot() + render(NewComponent)   │
│     → State lost, but page updates          │
│                                             │
└─────────────────────────────────────────────┘
```

### Critical Design Decisions

#### 1. Module ID Consistency
The `$RefreshReg$` registration ID **must be identical** between initial hydration and HMR updates. Both use `"/_modules/pages/<relative_path>"` as the moduleId prefix.

- **Server** (`getTransformedModule`): `moduleId = "/_modules/pages/" + relative(PAGES_DIR, path)`
- **Client** (`handleMessage`): `__CURRENT_MODULE__ = "/_modules" + mod` where mod = `/pages/index.tsx`
- **Transform wrapper**: scoped `var $RefreshReg$` uses the moduleId from server

#### 2. Devtools Hook Pre-Script
React DOM calls `__REACT_DEVTOOLS_GLOBAL_HOOK__.inject()` during initialization. The React Refresh runtime needs this hook to exist so it can connect to the renderer. A small sync script creates the hook BEFORE the client bundle loads.

#### 3. Babel Transform Pipeline
```
Source TSX
  → @babel/preset-typescript (strip types)
  → @babel/preset-react (JSX → createElement, classic mode)
  → react-refresh/babel (inject $RefreshReg$/$RefreshSig$ calls)
  → Strip React imports (use window.React instead)
  → Inject: const React = window.React; + hooks destructuring
  → Wrap with scoped $RefreshReg$/$RefreshSig$ (uses real RefreshRuntime)
```

#### 4. Cache Busting via Query String
Dynamic imports use `?v=<incrementing_number>` to force fresh fetches. The browser's ES module registry treats each URL as a new module, but React Refresh maps them via consistent registration IDs.

#### 5. hydrateRoot for First Load
First render uses `hydrateRoot()` to match SSR output. The root reference is kept for Fast Refresh. Fallback uses `createRoot()` (unmounts first).

### Files (poc-hmr-v2/)

| File | Role |
|------|------|
| `server.tsx` | Elysia server, file watcher, WebSocket, transform endpoint, SSR |
| `client-entry.ts` | Browser: React globals, Refresh runtime, WS client, hydration |
| `transform.ts` | Babel transform + React Refresh wrapper injection |
| `pages/*.tsx` | Page components (test subjects) |

---

## Integration Plan for packages/core

### Current Architecture (packages/core)

```
elysion.ts   → Main plugin: scanPages + buildClient + route plugins + static serving
router.ts    → File scanner, route pattern conversion, createRoutePlugin
render.tsx   → SSR/SSG/ISR rendering, layout chain, loader execution
shell.tsx    → HTML template with head management, __ELYSION_DATA__, script tags
build.ts     → Bun.build client bundle, generates _hydrate.tsx entry
client.ts    → Types: createRoute, page, PageModule, layouts
types.ts     → Type guards: isElysionPage, isElysionRoute
```

### What Needs to Change

#### New Files

| File | Purpose |
|------|---------|
| `src/hmr/transform.ts` | Babel transform (from poc-hmr-v2, adapted) |
| `src/hmr/client-entry.ts` | Browser HMR client (from poc-hmr-v2, adapted for multi-route) |
| `src/hmr/watcher.ts` | File watcher + WebSocket broadcast logic |
| `src/hmr/refresh-setup.ts` | Devtools hook pre-script content |

#### Modified Files

| File | Changes |
|------|---------|
| `src/elysion.ts` | Add HMR endpoints when `dev=true`: `/__hmr` WS, `/__client.js`, `/_modules/*`, `/__refresh-setup.js` |
| `src/shell.tsx` | In dev mode: add `<script src="/__refresh-setup.js">` before client script |
| `src/build.ts` | In dev mode: build HMR client-entry instead of static _hydrate.tsx |
| `src/render.tsx` | No structural changes (already supports dev mode fresh imports) |
| `src/router.ts` | No structural changes (already scans pages) |

### Adaptation Challenges (poc → core)

#### 1. Multi-Route Support
POC has one hardcoded page (`pages/index.tsx`). Core has dynamic routes with params, layouts, and loaders.

**Solution**: The HMR client must:
- Know the current route (match `window.location.pathname` to a pattern)
- Import the correct module path (`/_modules/pages/<matched_file>`)
- Re-run loaders if the page has one (or skip for SSG pages)
- Rebuild the layout chain with the new component

#### 2. Layout Chain
Core supports nested layouts via `route.tsx` files. When a layout changes, all child pages need to re-render.

**Solution**: File watcher detects `route.tsx` changes → broadcasts to client → client re-imports the layout module and rebuilds the element tree.

#### 3. Loader Data
Pages can have server-side loaders. On HMR update, the component changes but loader data stays the same (it's already in `__ELYSION_DATA__`).

**Solution**: Re-use existing `__ELYSION_DATA__` for HMR re-renders. Only fetch fresh data on full page navigation.

#### 4. createRoute/page Convention
POC uses simple `export default function Page()`. Core uses `createRoute().page({ component, loader, head })`.

**Solution**: The transform must handle the `page()` wrapper. The HMR client imports the module and accesses `.component` from the page object, not `.default` directly. Or: the module transform could extract and re-export the component.

#### 5. Client Bundle Split
Current build uses code splitting (`splitting: true`). HMR client needs all dependencies in one bundle.

**Solution**: In dev mode, build a single HMR client bundle (no splitting) that includes React, ReactDOM, Refresh runtime, and HMR WebSocket client. Page modules are loaded dynamically via `/_modules/*`.

### Implementation Order

1. **Create `src/hmr/` directory** with transform.ts, watcher.ts, refresh-setup.ts (adapted from poc)
2. **Create `src/hmr/client-entry.ts`** — multi-route aware HMR client
3. **Modify `src/elysion.ts`** — add dev-only HMR endpoints
4. **Modify `src/shell.tsx`** — inject refresh-setup script in dev mode
5. **Modify `src/build.ts`** — build HMR client bundle in dev mode
6. **Test with examples/simple** — verify HMR works with real routes, layouts, loaders
7. **Handle edge cases** — layout changes, dynamic routes, SSG/SSR/ISR modes

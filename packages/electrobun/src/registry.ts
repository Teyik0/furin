/** Shared across the separately bundled app artifact and SDK host. No Elysia import. */
import type { ApplicationRuntime, DesktopAppOptions, DesktopContext } from "./capabilities";
import type { DesktopApp } from "./runtime";

export type DesktopMode = "dev" | "build";
export type DesktopGuard = (request: Request) => Response | undefined;

export interface DesktopState {
  closed?: Promise<void>;
  guard?: DesktopGuard;
  hooks?: DesktopAppOptions;
  listening?: Promise<void>;
  paused?: boolean;
  ready?: () => Promise<void>;
  runtime?: ApplicationRuntime;
  stop: () => Promise<void>;
  validate: (mode: DesktopMode) => Promise<() => void>;
  webBootstrap?: (request: Request, peerAddress: string | undefined) => Response | undefined;
  webDevelopment?: boolean;
}

export interface DesktopEntry {
  app?: DesktopApp;
  guard: DesktopGuard;
  mode: DesktopMode;
  runtime: ApplicationRuntime | undefined;
  state?: DesktopState;
  webBootstrap?: (request: Request, peerAddress: string | undefined) => Response | undefined;
  webDevelopment?: boolean;
}

const registryKey: unique symbol = Symbol.for("@teyik0/furin-electrobun/roots/v3");
const shared = globalThis as typeof globalThis & {
  [registryKey]?: WeakMap<object, DesktopState>;
};
const roots = (shared[registryKey] ??= new WeakMap<object, DesktopState>());
const entryKey: unique symbol = Symbol.for("@teyik0/furin-electrobun/entry/v1");
const entryShared = globalThis as typeof globalThis & {
  [entryKey]?: DesktopEntry;
};

export async function withDesktopEntry<T>(entry: DesktopEntry, load: () => Promise<T>): Promise<T> {
  // Bun's module evaluation does not inherit AsyncLocalStorage from import().
  // The native host imports one application, sharing this scope across bundles.
  const previous = entryShared[entryKey];
  entryShared[entryKey] = entry;
  try {
    return await load();
  } finally {
    entryShared[entryKey] = previous;
  }
}

export function getDesktopEntry(): DesktopEntry | undefined {
  return entryShared[entryKey];
}

export function registerDesktopApp(app: DesktopApp, state: DesktopState): void {
  roots.set(app, state);
  const entry = getDesktopEntry();
  if (entry && !entry.app) {
    entry.app = app;
    entry.state = state;
  }
}

export function getDesktopState(app: object): DesktopState | undefined {
  return roots.get(app);
}

export function activateDesktopApp(
  app: object,
  guard: DesktopGuard,
  mode: DesktopMode
): Promise<() => void> {
  const state = roots.get(app);
  if (!state) {
    throw new Error(
      'Desktop root must use desktopApp() from "@teyik0/furin-electrobun/server" before listening.'
    );
  }
  state.guard = guard;
  return state.validate(mode);
}

const hostKey: unique symbol = Symbol.for("@teyik0/furin-electrobun/host/v1");
const hostShared = globalThis as typeof globalThis & { [hostKey]?: DesktopContext };

export function setDesktopHost(desktop: DesktopContext | undefined): void {
  hostShared[hostKey] = desktop;
}

/** The live controller is shared by native modules and separately bundled Elysia plugins. */
export function getDesktopHost(): DesktopContext | null {
  return hostShared[hostKey] ?? null;
}

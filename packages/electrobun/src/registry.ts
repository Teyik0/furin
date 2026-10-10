/** Shared across the separately bundled app artifact and SDK host. No Elysia import. */
import type { ApplicationRuntime, DesktopAppOptions, ReadyBackend } from "./capabilities";

export type DesktopMode = "dev" | "build";
export type DesktopGuard = (request: Request) => Response | undefined;

export interface DesktopState {
  guard?: DesktopGuard;
  hooks?: DesktopAppOptions;
  paused?: boolean;
  ready?: (backend: ReadyBackend) => Promise<void>;
  recover?: (backend: ReadyBackend) => Promise<void>;
  runtime?: ApplicationRuntime;
  start: (signal?: AbortSignal) => Promise<void>;
  stop: () => Promise<void>;
  validate: (mode: DesktopMode) => Promise<() => void>;
}

const registryKey: unique symbol = Symbol.for("@teyik0/furin-electrobun/roots/v3");
const shared = globalThis as typeof globalThis & {
  [registryKey]?: WeakMap<object, DesktopState>;
};
const roots = (shared[registryKey] ??= new WeakMap<object, DesktopState>());

export function registerDesktopApp(app: object, state: DesktopState): void {
  roots.set(app, state);
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
      'Desktop root must use desktopApp() from "@teyik0/furin-electrobun/server" as its first plugin.'
    );
  }
  state.guard = guard;
  return state.validate(mode);
}

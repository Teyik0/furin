/** Shared across the separately bundled app artifact and SDK host. No Elysia import. */
export type DesktopMode = "dev" | "build";
export type DesktopGuard = (request: Request) => Response | undefined;

export interface DesktopState {
  guard?: DesktopGuard;
  start: (signal?: AbortSignal) => Promise<void>;
  stop: () => Promise<void>;
  validate: (mode: DesktopMode) => Promise<() => void>;
}

const registryKey: unique symbol = Symbol.for("@teyik0/furin-electrobun/roots/v2");
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

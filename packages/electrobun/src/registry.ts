/** Shared across the separately bundled app artifact and SDK host. No Elysia import. */
export type DesktopMode = "dev" | "build";
export type DesktopGuard = (request: Request) => Response | undefined;

export interface DesktopState {
  guard?: DesktopGuard;
  validate: (mode: DesktopMode) => Promise<() => void>;
}

const registryKey: unique symbol = Symbol.for("@teyik0/furin-electrobun/roots/v1");
const shared = globalThis as typeof globalThis & {
  [registryKey]?: WeakMap<object, DesktopState>;
};
const roots = (shared[registryKey] ??= new WeakMap<object, DesktopState>());

export function registerDesktopApp(app: object, state: DesktopState): void {
  roots.set(app, state);
}

export function activateDesktopApp(
  app: object,
  guard: DesktopGuard,
  mode: DesktopMode
): Promise<() => void> {
  const state = roots.get(app);
  if (!state) {
    throw new Error(
      'Desktop root must use createDesktopApp() from "@teyik0/furin-electrobun/server" instead of new Elysia().'
    );
  }
  state.guard = guard;
  return state.validate(mode);
}

/** Serializable boundary between Elysia and the native host. No SDK or Elysia value imports. */
import type { BrowserWindow } from "electrobun/main";
import type {
  AssociationResult,
  AssociationTarget,
  DesktopHost,
  DesktopSnapshot,
  DesktopWindowOptions,
} from "./capabilities";

/** SDK window methods whose arguments and results are plain data. */
export const DESKTOP_WINDOW_METHODS = [
  "activate",
  "center",
  "close",
  "focus",
  "getFrame",
  "getPageZoom",
  "getPosition",
  "getSize",
  "hide",
  "isAlwaysOnTop",
  "isFullScreen",
  "isMaximized",
  "isMinimized",
  "isVisible",
  "maximize",
  "minimize",
  "requestClose",
  "setAlwaysOnTop",
  "setFrame",
  "setFullScreen",
  "setPageZoom",
  "setPosition",
  "setSize",
  "setTitle",
  "show",
  "unmaximize",
  "unminimize",
] as const;

type WindowMethod = (typeof DESKTOP_WINDOW_METHODS)[number];

export type DesktopWindow = {
  [Method in WindowMethod]: (
    ...args: Parameters<BrowserWindow[Method]>
  ) => Promise<ReturnType<BrowserWindow[Method]>>;
};

/** Window options that can cross the process boundary; RPC belongs to native modules. */
export type DesktopWindowCreateOptions = Omit<DesktopWindowOptions, "rpc"> & { path: string };

export type NativeCommands<T> = { [Name in keyof T]: (...args: never) => Promise<unknown> };

/** Furin generates the augmentation from the native entrypoint's default export. */
// biome-ignore lint/suspicious/noEmptyInterface: Declaration-merging target for generated types.
export interface Register {}

type RegisteredNative = Register extends { native: infer Native } ? Native : Record<never, never>;

/** Elysia-side desktop capabilities. Every call is asynchronous and serializable in all modes. */
export interface DesktopContext {
  associations: {
    read: (target: AssociationTarget) => Promise<AssociationResult>;
    requestDefault: (target: AssociationTarget) => Promise<AssociationResult>;
  };
  browser: { open: (destination?: string) => Promise<boolean> };
  native: RegisteredNative;
  open: () => Promise<void>;
  quit: () => Promise<void>;
  restart: () => Promise<void>;
  snapshot: () => Promise<DesktopSnapshot>;
  updates: { install: () => Promise<void> };
  window: DesktopWindow;
  windows: {
    create: (name: string, options: DesktopWindowCreateOptions) => Promise<DesktopWindow>;
    get: (name: string) => DesktopWindow;
  };
}

export type DesktopCommand =
  | { type: "window"; name: string; method: WindowMethod; args: unknown[] }
  | { type: "create"; name: string; options: DesktopWindowCreateOptions }
  | { type: "open" | "quit" | "restart" | "snapshot" | "update" }
  | { type: "browser"; destination: string | undefined }
  | { type: "association"; operation: "read" | "requestDefault"; target: AssociationTarget }
  | { type: "native"; name: string; args: unknown[] };

export type DesktopTransport = (command: DesktopCommand) => Promise<unknown>;

/** Declares the native commands Elysia can call. Use it as the native entrypoint's default export. */
export function defineNative<const T extends NativeCommands<T>>(commands: T): T {
  return commands;
}

function nativeCommand(
  native: unknown,
  name: string
): ((...args: unknown[]) => unknown) | undefined {
  if (typeof native === "object" && native !== null && Object.hasOwn(native, name)) {
    const command: unknown = Reflect.get(native, name);
    if (typeof command === "function") {
      return command as (...args: unknown[]) => unknown;
    }
  }
}

/** Runs one command against the live native host. Both transports end here. */
export async function executeDesktopCommand(
  host: DesktopHost,
  native: unknown,
  command: DesktopCommand
): Promise<unknown> {
  switch (command.type) {
    case "window": {
      const window = host.windows.get(command.name);
      if (!window) {
        throw new Error(`Desktop window is not open: ${command.name}`);
      }
      if (!DESKTOP_WINDOW_METHODS.includes(command.method)) {
        throw new Error(`Unsupported desktop window method: ${command.method}`);
      }
      return Reflect.apply(window[command.method], window, command.args);
    }
    case "create":
      host.windows.create(command.name, command.options);
      return;
    case "open":
      host.open();
      return;
    case "quit":
      return await host.quit();
    case "restart":
      return await host.restart();
    case "snapshot":
      return host.snapshot();
    case "update":
      return await host.updates.install();
    case "browser":
      return host.browser.open(command.destination);
    case "association":
      return await host.associations[command.operation](command.target);
    case "native": {
      const run = nativeCommand(native, command.name);
      if (!run) {
        throw new Error(`Unknown native command: ${command.name}`);
      }
      return await run(...command.args);
    }
    default:
      throw new Error("Unknown desktop command.");
  }
}

/** Plain-data copy, so in-process calls behave exactly like the development channel. */
export function toWire<T>(value: T): T {
  return value === undefined ? value : JSON.parse(JSON.stringify(value));
}

export function inProcessTransport(host: DesktopHost, native: () => unknown): DesktopTransport {
  return async (command) => toWire(await executeDesktopCommand(host, native(), toWire(command)));
}

export function createDesktopContext(call: DesktopTransport): DesktopContext {
  const windowHandle = (name: string) =>
    Object.fromEntries(
      DESKTOP_WINDOW_METHODS.map((method) => [
        method,
        (...args: unknown[]) => call({ type: "window", name, method, args }),
      ])
    ) as DesktopWindow;
  const native = new Proxy(
    {},
    {
      get(_target, name) {
        // Never look like a thenable: awaiting the namespace must not send a command.
        if (typeof name !== "string" || name === "then") {
          return;
        }
        return (...args: unknown[]) => call({ type: "native", name, args });
      },
    }
  ) as RegisteredNative;
  return {
    associations: {
      read: (target) =>
        call({ type: "association", operation: "read", target }) as Promise<AssociationResult>,
      requestDefault: (target) =>
        call({
          type: "association",
          operation: "requestDefault",
          target,
        }) as Promise<AssociationResult>,
    },
    browser: {
      open: (destination) => call({ type: "browser", destination }) as Promise<boolean>,
    },
    native,
    open: async () => {
      await call({ type: "open" });
    },
    quit: async () => {
      await call({ type: "quit" });
    },
    restart: async () => {
      await call({ type: "restart" });
    },
    snapshot: () => call({ type: "snapshot" }) as Promise<DesktopSnapshot>,
    updates: {
      install: async () => {
        await call({ type: "update" });
      },
    },
    window: windowHandle("main"),
    windows: {
      async create(name, options) {
        await call({ type: "create", name, options });
        return windowHandle(name);
      },
      get: windowHandle,
    },
  };
}

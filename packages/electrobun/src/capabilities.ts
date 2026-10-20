export interface DesktopIdentity {
  channel: string;
  identifier: string;
  name: string;
  version: string;
}

export interface DirectoryOptions {
  startingFolder?: string;
}

export interface MessageOptions {
  buttons?: string[];
  cancelId?: number;
  defaultId?: number;
  detail?: string;
  message: string;
  title: string;
  type: "info" | "warning" | "error" | "question";
}

export interface NotificationOptions {
  body?: string;
  silent?: boolean;
  subtitle?: string;
  title: string;
}

export interface NativeUpdateInfo {
  error: string;
  hash: string;
  updateAvailable: boolean;
  updateReady: boolean;
  version: string;
}

export interface NativeUpdateStatus {
  details?: { progress?: number; errorMessage?: string };
  message: string;
  status: string;
  timestamp: number;
}

export type OpenEvent = { type: "url"; url: string } | { type: "file"; path: string };
export type AssociationTarget = { extension: string; mimeType?: string } | { scheme: string };
export type AssociationResult =
  | { status: "confirmed"; application: string | null }
  | { status: "user-action-required" | "unsupported" };

export interface DesktopSnapshot {
  background: boolean;
  phase: "starting" | "ready" | "updating" | "restarting" | "quitting" | "stopped";
  trayVisible: boolean;
  webviews: number;
  windows: number;
}

export interface DesktopCapabilities {
  associations: {
    read: (target: AssociationTarget) => Promise<AssociationResult>;
    requestDefault: (target: AssociationTarget) => Promise<AssociationResult>;
  };
  browser: { open: (destination?: string) => boolean };
  dialogs: {
    selectDirectory: (options?: DirectoryOptions) => Promise<string | null>;
    message: (options: MessageOptions) => Promise<{ response: number }>;
  };
  notifications: { show: (options: NotificationOptions) => void };
  quit: () => Promise<void>;
  restart: () => Promise<void>;
  shell: {
    openExternal: (url: string) => boolean;
    openPath: (path: string) => boolean;
    showItemInFolder: (path: string) => void;
  };
  snapshot: () => DesktopSnapshot;
  updates: {
    check: () => Promise<NativeUpdateInfo>;
    download: () => Promise<void>;
    install: () => Promise<void>;
    snapshot: () => NativeUpdateInfo;
    subscribe: (listener: (status: NativeUpdateStatus) => void) => () => void;
  };
  window: { open: () => DesktopSnapshot; background: () => Promise<void> };
}

export type ApplicationRuntime =
  | { kind: "server" }
  | {
      kind: "desktop";
      identity: DesktopIdentity;
      desktop: DesktopCapabilities;
      signal?: AbortSignal;
    };

export interface StartupContext {
  runtime: ApplicationRuntime;
  signal: AbortSignal;
}

export interface ReadyBackend {
  /** Trusted backend hooks only; never serialize this into browser data. */
  cookie?: string;
  origin: string;
}

export interface ReadyContext extends StartupContext {
  backend: ReadyBackend;
}

export interface NativeActionContext {
  desktop: DesktopCapabilities;
  identity: DesktopIdentity;
}

export type NativeMenuItem =
  | { type: "divider" }
  | {
      label?: string;
      role?: string;
      accelerator?: string;
      enabled?: boolean;
      checked?: boolean;
      submenu?: NativeMenuItem[];
      onSelect?: (context: NativeActionContext) => unknown | Promise<unknown>;
    };

/** Native work that failed outside a request: open events, menu actions, update listeners, quit. */
export type NativeOperation = "open" | "action" | "updates" | "quit";

export interface DesktopAppOptions {
  background?: () => boolean;
  menus?: (context: NativeActionContext) => NativeMenuItem[];
  /**
   * Receives native failures that have no HTTP response to carry them. The error
   * is unredacted: it may contain open-event URLs, so sanitize before persisting.
   */
  onError?: (context: { operation: NativeOperation; error: unknown }) => void;
  onOpen?: (context: NativeActionContext & { event: OpenEvent }) => void | Promise<void>;
  onReady?: (context: ReadyContext) => void | Promise<void>;
  onShutdown?: (context: StartupContext) => void | Promise<void>;
  onStartup?: (context: StartupContext) => void | Promise<void>;
  restrictWebToLoopback?: boolean;
  tray?: (context: NativeActionContext) => NativeMenuItem[];
}

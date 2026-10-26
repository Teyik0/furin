import type { BrowserWindow, WindowOptionsType } from "electrobun/main";
import type { RPCWithTransport } from "electrobun/main/rpc";

export interface DesktopIdentity {
  channel: string;
  identifier: string;
  name: string;
  version: string;
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

/** SDK options for an authenticated local window. Furin owns its URL and navigation boundary. */
export type DesktopWindowOptions<T extends RPCWithTransport = RPCWithTransport> = Omit<
  Partial<WindowOptionsType<T>>,
  "url" | "html" | "navigationRules" | "allowedProtocols" | "viewsRoot"
>;

export interface DesktopContext {
  associations: {
    read: (target: AssociationTarget) => Promise<AssociationResult>;
    requestDefault: (target: AssociationTarget) => Promise<AssociationResult>;
  };
  browser: { open: (destination?: string) => boolean };
  open: () => BrowserWindow;
  quit: () => Promise<void>;
  restart: () => Promise<void>;
  snapshot: () => DesktopSnapshot;
  updates: { install: () => Promise<void> };
  readonly window: BrowserWindow | undefined;
  windows: {
    get: (name: string) => BrowserWindow | undefined;
    create: <T extends RPCWithTransport>(
      name: string,
      options: DesktopWindowOptions<T> & { path: string }
    ) => BrowserWindow<T>;
  };
}

export type ApplicationRuntime =
  | { kind: "server" }
  | {
      kind: "desktop";
      identity: DesktopIdentity;
      desktop: DesktopContext;
      signal?: AbortSignal;
    };

export interface NativeActionContext {
  desktop: DesktopContext;
  identity: DesktopIdentity;
}

/** Facts the listener establishes before an application authenticates a network request. */
export interface AdmissionContext {
  /** A managed native host installed its private window guard. */
  desktopHost: boolean;
  /** The native window or CLI web-development owner cookie, origin and loopback peer were verified.
   * This grants owner admission, not native capabilities; desktopHost remains false in web dev. */
  desktopSession: boolean;
  /** TCP peer address reported by Bun; never derived from request headers. */
  peerAddress: string | undefined;
}

export interface DesktopAppOptions {
  /**
   * Authenticates every listener request before routing, including requests without the
   * native window session. Return a Response to reject it. In-process dispatch never calls it.
   */
  admission?: (request: Request, context: AdmissionContext) => Response | undefined;
  background?: () => boolean;
  restrictWebToLoopback?: boolean;
  window?: DesktopWindowOptions;
}

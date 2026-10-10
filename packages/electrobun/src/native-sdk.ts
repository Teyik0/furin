import type {
  DesktopIdentity,
  MessageOptions,
  NativeUpdateInfo,
  NativeUpdateStatus,
  NotificationOptions,
} from "./capabilities";

/** Public Electrobun 2.0.2 Bun API only. The host supplies its one canonical SDK. */
export interface NativeWebview {
  executeJavascript: (script: string) => void;
  on: (name: "dom-ready" | "will-navigate", callback: (event: unknown) => void) => unknown;
  setNavigationRules: (rules: string[]) => void;
}
export interface NativeWindow {
  activate: () => void;
  close: () => void;
  on: (name: "close", callback: () => void) => unknown;
  requestClose: () => void;
  show: () => void;
  webview?: NativeWebview;
  webviewId: number;
}
export type SdkMenuItem = { type: "divider" } | SdkNormalMenuItem;
export interface SdkNormalMenuItem {
  accelerator?: string;
  action?: string;
  checked?: boolean;
  enabled?: boolean;
  label: string;
  role?: string;
  submenu?: SdkMenuItem[];
  type: "normal";
}
export interface NativeTray {
  on: (name: "tray-clicked", callback: (event: unknown) => void) => unknown;
  remove: () => void;
  setMenu: (items: SdkMenuItem[]) => void;
  visible: boolean;
}
export interface DesktopSdk {
  ApplicationMenu: {
    setApplicationMenu: (menu: SdkMenuItem[]) => void;
    on: (name: "application-menu-clicked", callback: (event: unknown) => void) => unknown;
  };
  BrowserView: { getAll: () => unknown[] };
  BrowserWindow: new (options: {
    title: string;
    frame: { width: number; height: number };
    url: string;
    renderer: "native";
    sandbox: boolean;
    allowedProtocols: { views: boolean; appData: boolean };
    navigationRules: string;
  }) => NativeWindow;
  default: {
    events: {
      on: (name: string, callback: (event: unknown) => void) => unknown;
      off?: (name: string, callback: (event: unknown) => void) => unknown;
    };
  };
  Tray: new (options: {
    image: string;
    template: boolean;
    title: string;
    width: number;
    height: number;
  }) => NativeTray;
  Updater: {
    getLocalInfo: () => Promise<DesktopIdentity>;
    checkForUpdate: () => Promise<NativeUpdateInfo>;
    downloadUpdate: () => Promise<void>;
    applyUpdate: () => Promise<void>;
    updateInfo: () => NativeUpdateInfo;
    getStatusHistory: () => NativeUpdateStatus[];
    onStatusChange: (listener: ((status: NativeUpdateStatus) => void) | null) => void;
  };
  Utils: {
    paths: { appData: string };
    openExternal: (url: string) => boolean;
    openPath: (path: string) => boolean;
    showItemInFolder: (path: string) => void;
    openFileDialog: (options: {
      startingFolder?: string;
      canChooseFiles: boolean;
      canChooseDirectory: boolean;
      allowsMultipleSelection: boolean;
    }) => Promise<string[]>;
    showMessageBox: (options: MessageOptions) => Promise<{ response: number }>;
    showNotification: (options: NotificationOptions) => void;
    quit: (code: number) => unknown;
  };
}

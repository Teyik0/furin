import { isAbsolute } from "node:path";
import { isPackageName } from "./package-name";

const IDENTIFIER = /^[a-zA-Z][a-zA-Z0-9-]*(?:\.[a-zA-Z0-9-]+)+$/;
const VERSION = /^\d+\.\d+\.\d+(?:-[\w.-]+)?(?:\+[\w.-]+)?$/;
const SCHEME = /^[a-z][a-z0-9+.-]*$/i;

/** SDK additions; Furin retains ownership of the main process and app artifact. */
export interface DesktopSdkConfig {
  app?: {
    urlSchemes?: string[];
    fileAssociations?: {
      ext: string[];
      name: string;
      role?: "Editor" | "Viewer" | "Shell" | "None";
      icon?: string;
    }[];
  };
  build?: {
    bun?: { external?: string[] };
    copy?: { [source: string]: string };
    mac?: { icons?: string; codesign?: boolean; notarize?: boolean; createDmg?: boolean };
    win?: { icon?: string };
    linux?: { icon?: string };
  };
  release?: { baseUrl?: string; generatePatch?: boolean };
}

export interface DesktopConfig {
  app: { name: string; identifier: string; version?: string };
  /** Absolute override; otherwise uses the OS app-data directory and identifier. */
  dataDir?: string;
  /** Server-only packages kept outside the SDK main bundle. */
  external?: string[];
  /** Project-relative or absolute Bun entrypoint for an application-owned native host. */
  hostEntry?: string;
  sdk?: DesktopSdkConfig;
  window: { width: number; height: number };
}

function object(value: unknown): value is { [key: string]: unknown } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function validateDesktopConfig(value: unknown): asserts value is DesktopConfig {
  if (!(object(value) && object(value.app) && object(value.window))) {
    throw new Error("Desktop config requires app and window.");
  }
  if (typeof value.app.name !== "string" || !value.app.name.trim()) {
    throw new Error("app.name must be nonempty.");
  }
  if (typeof value.app.identifier !== "string" || !IDENTIFIER.test(value.app.identifier)) {
    throw new Error("app.identifier must be a reverse-domain identifier.");
  }
  for (const dimension of ["width", "height"] as const) {
    const size = value.window[dimension];
    if (typeof size !== "number" || !Number.isSafeInteger(size) || size <= 0) {
      throw new Error(`window.${dimension} must be a positive integer.`);
    }
  }
  if (
    value.app.version !== undefined &&
    (typeof value.app.version !== "string" || !VERSION.test(value.app.version))
  ) {
    throw new Error("app.version must be a semantic version.");
  }
  if (
    value.dataDir !== undefined &&
    (typeof value.dataDir !== "string" || !isAbsolute(value.dataDir))
  ) {
    throw new Error("dataDir must be absolute.");
  }
  if (
    value.external !== undefined &&
    (!Array.isArray(value.external) || value.external.some((name: unknown) => !isPackageName(name)))
  ) {
    throw new Error("external must contain package names, not paths.");
  }
  validateHost(value);
}

function validateHost(value: { [key: string]: unknown }) {
  if (
    value.hostEntry !== undefined &&
    (typeof value.hostEntry !== "string" || !value.hostEntry.trim())
  ) {
    throw new Error("hostEntry must be a nonempty path.");
  }
  if (value.sdk !== undefined && !object(value.sdk)) {
    throw new Error("sdk must be an object.");
  }
  if (value.sdk !== undefined) {
    validateSdkConfig(value.sdk);
  }
}

function validateSdkConfig(sdk: { [key: string]: unknown }) {
  for (const section of ["app", "build", "release"]) {
    if (sdk[section] !== undefined && !object(sdk[section])) {
      throw new Error(`sdk.${section} must be an object.`);
    }
  }
  validateSdkApp(sdk.app);
  if (object(sdk.build)) {
    validateSdkBuild(sdk.build);
  }
  validateSdkRelease(sdk.release);
}

function validateSdkApp(app: unknown) {
  if (
    object(app) &&
    app.urlSchemes !== undefined &&
    (!Array.isArray(app.urlSchemes) ||
      app.urlSchemes.some((scheme: unknown) => typeof scheme !== "string" || !SCHEME.test(scheme)))
  ) {
    throw new Error("sdk.app.urlSchemes must contain URL schemes without colons.");
  }
}

function validateSdkBuild(build: { [key: string]: unknown }) {
  if (
    build.copy !== undefined &&
    (!object(build.copy) ||
      Object.entries(build.copy).some(
        ([source, target]) => !source || typeof target !== "string" || !target
      ))
  ) {
    throw new Error("sdk.build.copy must map source paths to destination paths.");
  }
  for (const name of ["mac", "win", "linux", "bun"]) {
    const platform = build[name];
    if (platform === undefined) {
      continue;
    }
    if (!object(platform)) {
      throw new Error(`sdk.build.${name} must be an object.`);
    }
    for (const flag of ["codesign", "notarize", "createDmg"]) {
      if (platform[flag] !== undefined && typeof platform[flag] !== "boolean") {
        throw new Error(`sdk.build.${name}.${flag} must be boolean.`);
      }
    }
    for (const icon of ["icon", "icons"]) {
      if (platform[icon] !== undefined && typeof platform[icon] !== "string") {
        throw new Error(`sdk.build.${name}.${icon} must be a path.`);
      }
    }
  }
}

function validateSdkRelease(release: unknown) {
  if (
    object(release) &&
    release.baseUrl !== undefined &&
    (typeof release.baseUrl !== "string" ||
      !URL.canParse(release.baseUrl) ||
      !["http:", "https:"].includes(new URL(release.baseUrl).protocol))
  ) {
    throw new Error("sdk.release.baseUrl must be an HTTP(S) URL.");
  }
}

export function defineDesktopConfig(config: DesktopConfig): DesktopConfig {
  validateDesktopConfig(config);
  return config;
}

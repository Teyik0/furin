import { isAbsolute } from "node:path";
import type { FurinConfig } from "@teyik0/furin/config";
import type { ElectrobunConfig } from "electrobun/main";
import { isPackageName } from "./package-name";

const IDENTIFIER = /^[a-zA-Z][a-zA-Z0-9-]*(?:\.[a-zA-Z0-9-]+)+$/;
const VERSION = /^\d+\.\d+\.\d+(?:-[\w.-]+)?(?:\+[\w.-]+)?$/;
const SCHEME = /^[a-z][a-z0-9+.-]*$/i;
const MIME = /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/i;
const DIRECTORY_NAME = /^[^/\\\0]+$/;
const ENVIRONMENT_NAME = /^[a-z_][a-z0-9_]*$/i;

/** Resolved for the launching user, never while packaging the application. */
export interface RuntimeDataDirectory {
  developmentName: string;
  env?: string;
  name: string;
}

/** SDK-derived packaging settings. Furin reserves the generated main entry and runtime lifecycle. */
export type DesktopSdkConfig = Omit<ElectrobunConfig, "app" | "build" | "runtime"> & {
  runtime?: Omit<NonNullable<ElectrobunConfig["runtime"]>, "exitOnLastWindowClosed">;
  build?: Omit<NonNullable<ElectrobunConfig["build"]>, "mainProcess"> & { mainProcess?: "bun" };
};

type SdkApp = ElectrobunConfig["app"];
type FileAssociation = NonNullable<SdkApp["fileAssociations"]>[number];

export interface DesktopConfig extends DesktopSdkConfig {
  app: Omit<SdkApp, "version" | "fileAssociations"> & {
    version?: string;
    fileAssociations?: (FileAssociation & { mimeType?: string })[];
  };
  /** Absolute override or runtime user-data policy; omitted preserves the SDK default. */
  dataDir?: string | RuntimeDataDirectory;
  /** Runtime packages copied with their dependencies into the Furin artifact. */
  external?: string[];
  protocols?: string[];
}

declare module "@teyik0/furin/config" {
  interface FurinConfigExtensions {
    desktop?: DesktopConfig;
  }
}

function object(value: unknown): value is { [key: string]: unknown } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function validateDesktopConfig(value: unknown): asserts value is DesktopConfig {
  if (!(object(value) && object(value.app))) {
    throw new Error("Desktop config requires app.");
  }
  if (typeof value.app.name !== "string" || !value.app.name.trim()) {
    throw new Error("app.name must be nonempty.");
  }
  if (typeof value.app.identifier !== "string" || !IDENTIFIER.test(value.app.identifier)) {
    throw new Error("app.identifier must be a reverse-domain identifier.");
  }
  if (
    value.app.version !== undefined &&
    (typeof value.app.version !== "string" || !VERSION.test(value.app.version))
  ) {
    throw new Error("app.version must be a semantic version.");
  }
  validateDataDirectory(value.dataDir);
  if (
    value.external !== undefined &&
    (!Array.isArray(value.external) || value.external.some((name: unknown) => !isPackageName(name)))
  ) {
    throw new Error("external must contain package names, not paths.");
  }
  validateHost(value);
  validateNativeConfig(value);
}

function validateDataDirectory(value: unknown) {
  if (value === undefined || (typeof value === "string" && isAbsolute(value))) {
    return;
  }
  if (
    object(value) &&
    [value.name, value.developmentName].every(
      (name) =>
        typeof name === "string" &&
        name.trim() &&
        DIRECTORY_NAME.test(name) &&
        name !== "." &&
        name !== ".."
    ) &&
    value.name !== value.developmentName &&
    (value.env === undefined || (typeof value.env === "string" && ENVIRONMENT_NAME.test(value.env)))
  ) {
    return;
  }
  throw new Error(
    "dataDir must be absolute or a runtime policy with distinct name/developmentName and an optional env name."
  );
}

function validateNativeConfig(value: { [key: string]: unknown }) {
  if (
    value.protocols !== undefined &&
    (!Array.isArray(value.protocols) ||
      value.protocols.some((scheme: unknown) => typeof scheme !== "string" || !SCHEME.test(scheme)))
  ) {
    throw new Error("protocols must contain valid app-private schemes.");
  }
}

function validateHost(value: { [key: string]: unknown }) {
  validateSdkConfig(value);
  if (object(value.build)) {
    const { build } = value;
    if (build.mainProcess !== undefined && build.mainProcess !== "bun") {
      throw new Error('build.mainProcess must be "bun" for Furin.');
    }
    if (
      object(build.bun) &&
      build.bun.entrypoint !== undefined &&
      (typeof build.bun.entrypoint !== "string" || !build.bun.entrypoint.trim())
    ) {
      throw new Error("build.bun.entrypoint must be a nonempty path.");
    }
  }
}

function validateSdkConfig(sdk: { [key: string]: unknown }) {
  for (const section of ["app", "build", "release"]) {
    if (sdk[section] !== undefined && !object(sdk[section])) {
      throw new Error(`${section} must be an object.`);
    }
  }
  validateSdkApp(sdk.app);
  if (object(sdk.build)) {
    validateSdkBuild(sdk.build);
  }
  validateSdkRelease(sdk.release);
}

function validateSdkApp(app: unknown) {
  if (!object(app)) {
    return;
  }
  if (
    app.urlSchemes !== undefined &&
    (!Array.isArray(app.urlSchemes) ||
      app.urlSchemes.some((scheme: unknown) => typeof scheme !== "string" || !SCHEME.test(scheme)))
  ) {
    throw new Error("app.urlSchemes must contain URL schemes without colons.");
  }
  if (
    app.fileAssociations !== undefined &&
    (!Array.isArray(app.fileAssociations) ||
      app.fileAssociations.some(
        (association: unknown) =>
          !(object(association) && Array.isArray(association.ext)) ||
          association.ext.length === 0 ||
          association.ext.some((ext: unknown) => typeof ext !== "string" || !ext.trim()) ||
          typeof association.name !== "string" ||
          !association.name.trim() ||
          (association.icon !== undefined &&
            (typeof association.icon !== "string" || !association.icon.trim())) ||
          (association.mimeType !== undefined &&
            (typeof association.mimeType !== "string" || !MIME.test(association.mimeType))) ||
          (association.role !== undefined &&
            (typeof association.role !== "string" ||
              !["Editor", "Viewer", "Shell", "None"].includes(association.role)))
      ))
  ) {
    throw new Error(
      "app.fileAssociations must contain valid extensions, names, roles, icons and MIME types."
    );
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
    throw new Error("build.copy must map source paths to destination paths.");
  }
  for (const name of ["mac", "win", "linux", "bun"]) {
    validateSdkPlatform(name, build[name]);
  }
}

function validateSdkPlatform(name: string, platform: unknown) {
  if (platform === undefined) {
    return;
  }
  if (!object(platform)) {
    throw new Error(`build.${name} must be an object.`);
  }
  for (const flag of ["codesign", "notarize", "createDmg", "bundleCEF", "bundleWGPU"]) {
    if (platform[flag] !== undefined && typeof platform[flag] !== "boolean") {
      throw new Error(`build.${name}.${flag} must be boolean.`);
    }
  }
  if (platform.defaultRenderer === "cef" && platform.bundleCEF !== true) {
    throw new Error(`build.${name}.defaultRenderer requires bundleCEF: true.`);
  }
  for (const icon of ["icon", "icons"]) {
    if (platform[icon] !== undefined && typeof platform[icon] !== "string") {
      throw new Error(`build.${name}.${icon} must be a path.`);
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
    throw new Error("release.baseUrl must be an HTTP(S) URL.");
  }
}

export function defineDesktopConfig(config: DesktopConfig): NonNullable<FurinConfig["desktop"]> {
  validateDesktopConfig(config);
  return config;
}

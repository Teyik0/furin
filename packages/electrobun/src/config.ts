import { isAbsolute } from "node:path";
import { isPackageName } from "./package-name";

const IDENTIFIER = /^[a-zA-Z][a-zA-Z0-9-]*(?:\.[a-zA-Z0-9-]+)+$/;
const VERSION = /^\d+\.\d+\.\d+(?:-[\w.-]+)?(?:\+[\w.-]+)?$/;

export interface DesktopConfig {
  app: { name: string; identifier: string; version?: string };
  /** Absolute override; otherwise uses the OS app-data directory and identifier. */
  dataDir?: string;
  /** Server-only packages kept outside the SDK main bundle. */
  external?: string[];
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
}

export function defineDesktopConfig(config: DesktopConfig): DesktopConfig {
  validateDesktopConfig(config);
  return config;
}

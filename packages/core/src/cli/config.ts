import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { t, Validator } from "elysia";
import type { TSchema } from "typebox";
import { BUILD_TARGETS, configSchema, type FurinConfig, type FurinTarget } from "../config.ts";

const compiledConfigSchema = Validator.create(configSchema);

// `plugins` and `targets` are validated separately: TypeBox cannot describe functions.
const configKeysSchema = t.Object({
  ...configSchema.properties,
  plugins: t.Any(),
  targets: t.Any(),
});
const MAX_SUGGESTION_DISTANCE = 2;

function editDistance(left: string, right: string): number {
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (const [leftIndex, leftChar] of [...left].entries()) {
    const current = [leftIndex + 1];
    for (const [rightIndex, rightChar] of [...right].entries()) {
      current.push(
        Math.min(
          (previous[rightIndex + 1] ?? 0) + 1,
          (current[rightIndex] ?? 0) + 1,
          (previous[rightIndex] ?? 0) + (leftChar === rightChar ? 0 : 1)
        )
      );
    }
    previous = current;
  }
  return previous[right.length] ?? 0;
}

function closestKey(key: string, validKeys: string[]): string | undefined {
  let best: { distance: number; key: string } | undefined;
  for (const candidate of validKeys) {
    const distance = editDistance(key.toLowerCase(), candidate.toLowerCase());
    if (distance <= MAX_SUGGESTION_DISTANCE && (best === undefined || distance < best.distance)) {
      best = { distance, key: candidate };
    }
  }
  return best?.key;
}

/** Returns a message for the first key that the config schema does not declare. */
function findUnknownKey(value: unknown, schema: TSchema, path: string): string | undefined {
  if (Array.isArray(value)) {
    if (!t.IsArray(schema)) {
      return;
    }
    for (const [index, item] of value.entries()) {
      const message = findUnknownKey(item, schema.items, `${path}/${index}`);
      if (message !== undefined) {
        return message;
      }
    }
    return;
  }
  if (!t.IsObject(schema) || typeof value !== "object" || value === null) {
    return;
  }
  const { properties } = schema;
  const validKeys = Object.keys(properties);
  for (const [key, child] of Object.entries(value)) {
    const childPath = `${path}/${key}`;
    const childSchema = properties[key];
    if (childSchema === undefined) {
      const suggestion = closestKey(key, validKeys);
      const hint =
        suggestion === undefined
          ? `Valid keys: ${validKeys.join(", ")}`
          : `Did you mean "${suggestion}"?`;
      return `unknown key "${key}" (path: ${childPath}). ${hint}`;
    }
    const message = findUnknownKey(child, childSchema, childPath);
    if (message !== undefined) {
      return message;
    }
  }
}

function isBunPlugin(value: unknown): value is Bun.BunPlugin {
  return (
    typeof value === "object" &&
    value !== null &&
    "name" in value &&
    typeof value.name === "string" &&
    "setup" in value &&
    typeof value.setup === "function"
  );
}

function isFurinTarget(value: unknown): value is FurinTarget {
  if (typeof value === "string") {
    return (BUILD_TARGETS as readonly string[]).includes(value);
  }
  return (
    typeof value === "object" &&
    value !== null &&
    "name" in value &&
    typeof value.name === "string" &&
    "capabilities" in value &&
    typeof value.capabilities === "object" &&
    "runtimeModule" in value &&
    typeof value.runtimeModule === "string" &&
    "onBuildComplete" in value &&
    typeof value.onBuildComplete === "function"
  );
}

const DEFAULT_CONFIG_FILENAMES = [
  "furin.config.ts",
  "furin.config.js",
  "furin.config.mjs",
] as const;

interface ResolvedCliConfig extends FurinConfig {
  configPath: string | null;
  /**
   * Only set when the config file declares one — leaving it undefined lets
   * buildApp fall back to scanning server.ts for `furin({ pagesDir, prefix })`
   * calls (multi-instance detection).
   */
  pagesDir?: string;
  plugins?: Bun.BunPlugin[];
  rootDir: string;
}

export async function loadCliConfig(
  cwd: string,
  explicitConfigPath?: string
): Promise<ResolvedCliConfig> {
  const rootDir = resolve(cwd);
  const configPath = explicitConfigPath
    ? resolve(rootDir, explicitConfigPath)
    : DEFAULT_CONFIG_FILENAMES.map((filename) => resolve(rootDir, filename)).find((path) =>
        existsSync(path)
      );

  if (!configPath) {
    return {
      configPath: null,
      rootDir,
    };
  }

  const imported = await import(pathToFileURL(configPath).href);
  const rawConfig: FurinConfig = imported.default ?? imported;

  // Extract plugins and targets before TypeBox validation: functions cannot be JSON-schema validated
  const { plugins, targets, ...configToValidate } = rawConfig;

  if (plugins !== undefined && !Array.isArray(plugins)) {
    throw new Error(
      `[furin] Invalid config at ${configPath}: "plugins" must be an array of BunPlugin objects`
    );
  }

  const unknownKey = findUnknownKey(rawConfig, configKeysSchema, "");
  if (unknownKey !== undefined) {
    throw new Error(`[furin] Invalid config at ${configPath}: ${unknownKey}`);
  }

  const invalidPluginIndex = (plugins ?? []).findIndex((plugin: unknown) => !isBunPlugin(plugin));
  if (invalidPluginIndex !== -1) {
    throw new Error(
      `[furin] Invalid config at ${configPath}: plugins[${invalidPluginIndex}] must be a Bun plugin object: { name: string, setup(build) {} }`
    );
  }

  if (targets !== undefined && !Array.isArray(targets)) {
    throw new Error(`[furin] Invalid config at ${configPath}: "targets" must be an array`);
  }
  const invalidTargetIndex = (targets ?? []).findIndex((target: unknown) => !isFurinTarget(target));
  if (invalidTargetIndex !== -1) {
    throw new Error(
      `[furin] Invalid config at ${configPath}: targets[${invalidTargetIndex}] must be one of ${BUILD_TARGETS.join(", ")}, or a deployment adapter object`
    );
  }

  if (!compiledConfigSchema.Check(configToValidate)) {
    const [firstError] = compiledConfigSchema.Errors(configToValidate);
    throw new Error(
      `[furin] Invalid config at ${configPath}: ${firstError?.message ?? "unknown error"} (path: ${firstError?.instancePath ?? "/"})`
    );
  }

  const resolvedRootDir = resolve(rootDir, configToValidate.rootDir ?? ".");
  return {
    ...configToValidate,
    configPath,
    pagesDir: configToValidate.pagesDir
      ? resolve(resolvedRootDir, configToValidate.pagesDir)
      : undefined,
    plugins,
    rootDir: resolvedRootDir,
    targets,
  };
}

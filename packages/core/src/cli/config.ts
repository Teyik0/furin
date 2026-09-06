import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { configSchema, type FurinConfig } from "../config.ts";
import { TypeCompiler } from "../shared/elysia-contract.ts";

const compiledConfigSchema = TypeCompiler.Compile(configSchema);

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

  // Extract plugins before TypeBox validation: functions cannot be JSON-schema validated
  const { plugins, ...configToValidate } = rawConfig;

  if (plugins !== undefined && !Array.isArray(plugins)) {
    throw new Error(
      `[furin] Invalid config at ${configPath}: "plugins" must be an array of BunPlugin objects`
    );
  }

  if (!compiledConfigSchema.Check(configToValidate)) {
    const [firstError] = compiledConfigSchema.Errors(configToValidate);
    throw new Error(
      `[furin] Invalid config at ${configPath}: ${firstError?.message ?? "unknown error"} (path: ${firstError?.path ?? "/"})`
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
  };
}

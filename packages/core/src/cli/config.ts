import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { TypeCompiler } from "elysia/type-system";
import { configSchema, type ElyraConfig } from "../config.ts";

const compiledConfigSchema = TypeCompiler.Compile(configSchema);

const DEFAULT_CONFIG_FILENAMES = [
  "elyra.config.ts",
  "elyra.config.js",
  "elyra.config.mjs",
] as const;

interface ResolvedCliConfig extends ElyraConfig {
  configPath: string | null;
  pagesDir: string;
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
      pagesDir: resolve(rootDir, "src/pages"),
    };
  }

  const imported = await import(pathToFileURL(configPath).href);
  const rawConfig: ElyraConfig = imported.default ?? imported;

  // Extract plugins before TypeBox validation: functions cannot be JSON-schema validated
  const { plugins, ...configToValidate } = rawConfig;

  if (plugins !== undefined && !Array.isArray(plugins)) {
    throw new Error(
      `[elyra] Invalid config at ${configPath}: "plugins" must be an array of BunPlugin objects`
    );
  }

  if (!compiledConfigSchema.Check(configToValidate)) {
    const [firstError] = compiledConfigSchema.Errors(configToValidate);
    throw new Error(
      `[elyra] Invalid config at ${configPath}: ${firstError?.message ?? "unknown error"} (path: ${firstError?.path ?? "/"})`
    );
  }

  const resolvedRootDir = resolve(rootDir, configToValidate.rootDir ?? ".");
  return {
    ...configToValidate,
    plugins,
    configPath,
    rootDir: resolvedRootDir,
    pagesDir: resolve(resolvedRootDir, configToValidate.pagesDir ?? "src/pages"),
  };
}

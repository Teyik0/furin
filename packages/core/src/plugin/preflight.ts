import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const STRIP_PLUGIN = "@teyik0/furin/strip-plugin";

function staticPlugins(bunfig: unknown): string[] {
  if (typeof bunfig !== "object" || bunfig === null || !("serve" in bunfig)) {
    return [];
  }
  const { serve } = bunfig;
  if (typeof serve !== "object" || serve === null || !("static" in serve)) {
    return [];
  }
  const staticConfig = serve.static;
  if (
    typeof staticConfig !== "object" ||
    staticConfig === null ||
    !("plugins" in staticConfig) ||
    !Array.isArray(staticConfig.plugins)
  ) {
    return [];
  }
  return staticConfig.plugins.filter((plugin): plugin is string => typeof plugin === "string");
}

/**
 * Bun loads `[serve.static]` plugins lazily, on the first browser bundle, so a
 * missing strip plugin only surfaces as an unrelated bundler error. Reading the
 * bunfig Bun uses (the one in the working directory) catches it at startup.
 */
export function stripPluginPreflightWarning(projectRoot: string): string | undefined {
  const bunfigPath = join(projectRoot, "bunfig.toml");
  const hasBunfig = existsSync(bunfigPath);
  const plugins = hasBunfig ? staticPlugins(Bun.TOML.parse(readFileSync(bunfigPath, "utf8"))) : [];
  if (plugins.includes(STRIP_PLUGIN)) {
    return;
  }
  const problem = hasBunfig
    ? `${bunfigPath} does not register ${STRIP_PLUGIN} in [serve.static] plugins.`
    : `No bunfig.toml found in ${projectRoot}, so ${STRIP_PLUGIN} is not registered for Bun's dev bundler.`;
  const suggested = [...plugins, STRIP_PLUGIN].map((plugin) => JSON.stringify(plugin)).join(", ");
  return [
    `[furin] ${problem}`,
    "Without it, server-only code reaches the browser bundle and Bun fails with unrelated errors such as",
    `'Browser polyfill for module "node:url" doesn't have a matching export named "fileURLToPath"'.`,
    "Add this to bunfig.toml and restart the dev server:",
    "",
    "[serve.static]",
    `plugins = [${suggested}]`,
    'env = "FURIN_PUBLIC_*"',
  ].join("\n");
}

let stripPluginChecked = false;

/** Warns once per process, however many Furin instances are mounted. */
export function warnIfStripPluginMissing(projectRoot: string): void {
  if (stripPluginChecked) {
    return;
  }
  stripPluginChecked = true;
  const warning = stripPluginPreflightWarning(projectRoot);
  if (warning !== undefined) {
    console.warn(warning);
  }
}

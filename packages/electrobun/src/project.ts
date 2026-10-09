import { constants, existsSync } from "node:fs";
import { access, chmod, link, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { type DesktopConfig, validateDesktopConfig } from "./config";

interface PackageManifest {
  name?: string;
  scripts?: { [name: string]: string };
  version?: string;
}

async function importFurinConfig(cwd: string) {
  const path = ["furin.config.ts", "furin.config.js", "furin.config.mjs"]
    .map((name) => join(cwd, name))
    .find(existsSync);
  const imported = path ? await import(pathToFileURL(path).href) : {};
  const config: { rootDir?: string; serverEntry?: string; desktop?: unknown } =
    imported.default ?? imported;
  return { path, config };
}

export async function initDesktop(root: string): Promise<void> {
  const packagePath = join(root, "package.json");
  const pkg: PackageManifest = JSON.parse(await readFile(packagePath, "utf8"));
  for (const name of ["dev:desktop", "build:desktop"]) {
    if (pkg.scripts?.[name] !== undefined) {
      throw new Error(`${name} already exists; nothing overwritten.`);
    }
  }
  const project = await importFurinConfig(root);
  const configPath = project.path ?? join(root, "furin.config.ts");
  if (project.path && project.config.desktop === undefined) {
    throw new Error(
      "Add desktop: defineDesktopConfig(...) to your existing furin.config.ts, then rerun init."
    );
  }
  if (project.config.desktop !== undefined) {
    validateDesktopConfig(project.config.desktop);
  }
  const name = pkg.name?.split("/").at(-1) ?? "Furin";
  const slug = name.replace(/[^a-zA-Z0-9-]/g, "-");
  const config: DesktopConfig = {
    app: { name, identifier: `local.furin.${slug}` },
    window: { width: 1024, height: 768 },
  };
  validateDesktopConfig(config);
  pkg.scripts = {
    ...pkg.scripts,
    "dev:desktop": "furin-electrobun dev",
    "build:desktop": "furin-electrobun build",
  };
  // Atomic replacement must still respect a deliberately read-only manifest.
  await access(packagePath, constants.W_OK);
  // biome-ignore lint/suspicious/noBitwiseOperators: Preserve permission bits, not the file-type bits.
  const mode = (await stat(packagePath)).mode & 0o777;
  const transaction = crypto.randomUUID();
  const stagedManifest = join(root, `.package.json.${transaction}.tmp`);
  const stagedConfig = join(root, `.furin.config.ts.${transaction}.tmp`);
  let configPublished = false;
  try {
    await writeFile(stagedManifest, `${JSON.stringify(pkg, null, 2)}\n`, { flag: "wx", mode });
    await chmod(stagedManifest, mode);
    if (!project.path) {
      await writeFile(
        stagedConfig,
        `import { defineConfig } from "@teyik0/furin/config";\nimport { defineDesktopConfig } from "@teyik0/furin-electrobun";\n\nexport default defineConfig({ desktop: defineDesktopConfig(${JSON.stringify(config, null, 2)}) });\n`,
        { flag: "wx" }
      );
      // Publish a complete new config without replacing a concurrent creation.
      await link(stagedConfig, configPath);
      configPublished = true;
    }
    await rename(stagedManifest, packagePath);
  } catch (error) {
    if (configPublished) {
      await rm(configPath);
    }
    throw error;
  } finally {
    await Promise.all([rm(stagedManifest, { force: true }), rm(stagedConfig, { force: true })]);
  }
}

export async function loadDesktopConfig(root: string): Promise<
  DesktopConfig & {
    app: DesktopConfig["app"] & { version: string };
  }
> {
  const { config: project } = await importFurinConfig(root);
  const config: unknown = project.desktop;
  if (config === undefined) {
    throw new Error("Add desktop: defineDesktopConfig(...) to furin.config.ts.");
  }
  validateDesktopConfig(config);
  const pkg: PackageManifest = await Bun.file(join(root, "package.json")).json();
  const version = config.app.version ?? pkg.version;
  if (!version) {
    throw new Error("Set app.version or a version in the consuming package.json.");
  }
  const resolved = { ...config, app: { ...config.app, version } };
  validateDesktopConfig(resolved);
  return resolved;
}

export async function loadFurinProject(cwd: string) {
  // Core validates the full config when building. Only its existing root/server
  // conventions are needed to point the desktop dev host at the source app.
  const { config } = await importFurinConfig(cwd);
  const root = resolve(cwd, config.rootDir ?? ".");
  return { root, serverEntry: resolve(root, config.serverEntry ?? "src/server.ts") };
}

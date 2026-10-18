import { afterAll, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { createContext, type TemplateId } from "../src/pipeline/context.ts";
import { stage2Selection } from "../src/pipeline/stages/2-selection.ts";
import { stage3Design } from "../src/pipeline/stages/3-design.ts";
import { stage5Generation } from "../src/pipeline/stages/5-generation.ts";

const REPO_ROOT = resolve(import.meta.dir, "../../..");
const CORE_DIR = resolve(REPO_ROOT, "packages/core");
const TSC = resolve(REPO_ROOT, "node_modules/.bin/tsc");
const BUN_STORE = resolve(REPO_ROOT, "node_modules/.bun");
// Workspaces whose installed packages the generated project borrows, in priority
// order. Core comes first so the app and Furin's declarations share one copy of
// React and Elysia types.
const WORKSPACE_MODULE_DIRS = [
  resolve(CORE_DIR, "node_modules"),
  resolve(REPO_ROOT, "apps/docs/node_modules"),
  resolve(REPO_ROOT, "node_modules"),
];

const tempDirs: string[] = [];

afterAll(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { force: true, recursive: true });
  }
});

/** Finds an installed copy of `name` in the monorepo without touching the network. */
function findInstalledPackage(name: string): string {
  if (name === "@teyik0/furin") {
    return CORE_DIR;
  }
  for (const modulesDir of WORKSPACE_MODULE_DIRS) {
    const candidate = resolve(modulesDir, name);
    if (existsSync(resolve(candidate, "package.json"))) {
      return candidate;
    }
  }
  const storePrefix = `${name.replace("/", "+")}@`;
  const storeEntry = readdirSync(BUN_STORE)
    .filter((entry) => entry.startsWith(storePrefix))
    .sort()
    .at(-1);
  if (storeEntry === undefined) {
    throw new Error(`No installed copy of ${name} found in the monorepo.`);
  }
  return resolve(BUN_STORE, storeEntry, "node_modules", name);
}

async function generateProject(templateId: TemplateId): Promise<string> {
  const parentDir = mkdtempSync(resolve(tmpdir(), `create-furin-typecheck-${templateId}-`));
  tempDirs.push(parentDir);
  const targetDir = resolve(parentDir, "app");
  const ctx = createContext({
    install: false,
    projectName: "app",
    projectNameKebab: "app",
    projectNamePascal: "App",
    targetDir,
    templateId,
    yes: true,
  });
  await stage2Selection(ctx);
  stage3Design(ctx);
  if (!ctx.manifest) {
    throw new Error("Manifest not loaded");
  }
  ctx.dependencies = ctx.manifest.dependencies;
  ctx.devDependencies = ctx.manifest.devDependencies;
  await stage5Generation(ctx);

  const packageNames = [
    ...Object.keys(ctx.manifest.dependencies),
    ...Object.keys(ctx.manifest.devDependencies),
  ];
  for (const name of packageNames) {
    if (name === "typescript" || name === "@biomejs/biome" || name === "ultracite") {
      continue;
    }
    const linkPath = resolve(targetDir, "node_modules", name);
    mkdirSync(dirname(linkPath), { recursive: true });
    symlinkSync(findInstalledPackage(name), linkPath, "dir");
  }
  return targetDir;
}

describe("generated projects", () => {
  if (!existsSync(resolve(CORE_DIR, "dist/furin.d.ts"))) {
    throw new Error(
      "packages/core/dist is missing. Run `bun run build` in packages/core before this test."
    );
  }

  for (const templateId of ["simple", "full"] as const) {
    it(`type-checks the untouched ${templateId} template`, async () => {
      const targetDir = await generateProject(templateId);
      const result = Bun.spawnSync([TSC, "--noEmit", "-p", targetDir], {
        cwd: targetDir,
        stderr: "pipe",
        stdout: "pipe",
      });
      const output = `${result.stdout.toString()}${result.stderr.toString()}`;
      expect(output).toBe("");
      expect(result.exitCode).toBe(0);
    }, 60_000);
  }
});

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripPluginPreflightWarning } from "../../src/plugin/preflight.ts";

const projectRoots: string[] = [];

function createProject(bunfig: string | undefined): string {
  const projectRoot = mkdtempSync(join(tmpdir(), "furin-strip-preflight-"));
  projectRoots.push(projectRoot);
  if (bunfig !== undefined) {
    writeFileSync(join(projectRoot, "bunfig.toml"), bunfig);
  }
  return projectRoot;
}

afterEach(() => {
  for (const projectRoot of projectRoots.splice(0)) {
    rmSync(projectRoot, { force: true, recursive: true });
  }
});

describe("strip plugin preflight", () => {
  test("accepts a bunfig that registers the strip plugin for static bundling", () => {
    const projectRoot = createProject(
      '[serve.static]\nplugins = ["bun-plugin-tailwind", "@teyik0/furin/strip-plugin"]\n'
    );

    expect(stripPluginPreflightWarning(projectRoot)).toBeUndefined();
  });

  test("prints the bunfig snippet when bunfig.toml is missing", () => {
    const projectRoot = createProject(undefined);

    const warning = stripPluginPreflightWarning(projectRoot);

    expect(warning).toContain(`No bunfig.toml found in ${projectRoot}`);
    expect(warning).toContain(
      '[serve.static]\nplugins = ["@teyik0/furin/strip-plugin"]\nenv = "FURIN_PUBLIC_*"'
    );
  });

  test("keeps the existing static plugins in the suggested snippet", () => {
    const projectRoot = createProject('[serve.static]\nplugins = ["bun-plugin-tailwind"]\n');

    const warning = stripPluginPreflightWarning(projectRoot);

    expect(warning).toContain(`${join(projectRoot, "bunfig.toml")} does not register`);
    expect(warning).toContain('plugins = ["bun-plugin-tailwind", "@teyik0/furin/strip-plugin"]');
    expect(warning).toContain('doesn\'t have a matching export named "fileURLToPath"');
  });
});

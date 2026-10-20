import { expect, test } from "bun:test";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { createTmpApp } from "../support/app-fixtures.ts";
import { runCli } from "../support/process.ts";

const ROUTE_MAP_ENTRY = '"/blog/:slug": typeof import("./src/pages/blog/[slug]").route;';
const FILE_ROUTES_ENTRY = `    "/blog/[slug]": {
      kind: "page";
      pattern: "/blog/:slug";
      parent: typeof import("./src/pages/root").route;
      pathParams: { slug: string };
    };`;

test("furin typegen writes furin-env.d.ts without starting the app", async () => {
  const app = createTmpApp("cli-app");
  try {
    rmSync(join(app.path, "furin-env.d.ts"));

    const result = await runCli(["typegen"], { cwd: app.path });

    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
    const content = readFileSync(join(app.path, "furin-env.d.ts"), "utf8");
    expect(content).toContain(ROUTE_MAP_ENTRY);
    expect(content).toContain(FILE_ROUTES_ENTRY);
  } finally {
    app.cleanup();
  }
});

test("furin build writes furin-env.d.ts for the root-mounted app", async () => {
  const app = createTmpApp("cli-app");
  try {
    rmSync(join(app.path, "furin-env.d.ts"));

    const result = await runCli(["build", "--target", "bun"], { cwd: app.path });

    expect(result.exitCode).toBe(0);
    const content = readFileSync(join(app.path, "furin-env.d.ts"), "utf8");
    expect(content).toContain(ROUTE_MAP_ENTRY);
    expect(content).toContain(FILE_ROUTES_ENTRY);
  } finally {
    app.cleanup();
  }
});

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import Elysia from "elysia";
import { elyra } from "../src/elyra.ts";
import { __resetCompileContext, __setCompileContext } from "../src/internal.ts";
import { setProductionTemplatePath } from "../src/render/template.ts";
import { __setDevMode } from "../src/runtime-env.ts";
import { runCli } from "./helpers/run-cli.ts";
import { createTmpApp, removeAppPath, writeAppFile } from "./helpers/tmp-app.ts";

const tmpApps: Array<{ cleanup: () => void }> = [];
const originalCwd = process.cwd();
const originalArgv = process.argv.slice();

function rememberTmpApp<T extends { cleanup: () => void }>(app: T): T {
  tmpApps.push(app);
  return app;
}

afterEach(() => {
  __setDevMode(true);
  setProductionTemplatePath(null);
  __resetCompileContext();
  process.chdir(originalCwd);
  process.argv.length = 0;
  process.argv.push(...originalArgv);

  while (tmpApps.length > 0) {
    tmpApps.pop()?.cleanup();
  }
});

describe.serial("elyra()", () => {
  test("writes dev files and returns an Elysia instance in dev mode", async () => {
    const app = rememberTmpApp(createTmpApp("cli-app"));
    __setDevMode(true);
    process.chdir(app.path);

    const instance = await elyra({
      pagesDir: join(app.path, "src/pages"),
    });

    expect(instance).toBeInstanceOf(Elysia);
    expect(existsSync(join(app.path, ".elyra/index.html"))).toBe(true);
    expect(existsSync(join(app.path, ".elyra/_hydrate.tsx"))).toBe(true);
  });

  test("throws a clear error in production when no CompileContext is set", () => {
    const app = rememberTmpApp(createTmpApp("cli-app"));
    __setDevMode(false);
    process.chdir(app.path);

    expect(elyra({ pagesDir: join(app.path, "src/pages") })).rejects.toThrow("bun run build");
  });

  test("uses the prebuilt bun manifest in production via CompileContext", async () => {
    const app = rememberTmpApp(createTmpApp("cli-app"));
    // Use subprocess to avoid Bun.build() EISDIR race with parallel test files
    const result = runCli(["build", "--target", "bun"], { cwd: app.path });
    expect(result.exitCode).toBe(0);

    __setDevMode(false);
    process.chdir(app.path);
    process.argv[1] = join(app.path, ".elyra/build/bun/server.js");

    const rootPath = join(app.path, "src/pages/root.tsx");
    const indexPath = join(app.path, "src/pages/index.tsx");
    const blogSlugPath = join(app.path, "src/pages/blog/[slug].tsx");

    const [rootMod, indexMod, blogSlugMod] = await Promise.all([
      import(rootPath),
      import(indexPath),
      import(blogSlugPath),
    ]);

    __setCompileContext({
      rootPath,
      modules: {
        [rootPath]: rootMod,
        [indexPath]: indexMod,
        [blogSlugPath]: blogSlugMod,
      },
      routes: [
        { pattern: "/", path: indexPath, mode: "ssg" },
        { pattern: "/blog/:slug", path: blogSlugPath, mode: "ssg" },
      ],
    });

    const plugin = await elyra({
      pagesDir: join(app.path, "src/pages"),
    });
    const server = new Elysia().use(plugin).listen(0);

    try {
      await Bun.sleep(50);
      expect(server.server).toBeDefined();
    } finally {
      server.stop();
    }
  }, 10_000);

  test("uses embedded assets in production (compiled binary mode)", async () => {
    const app = rememberTmpApp(createTmpApp("cli-app"));
    __setDevMode(false);
    process.chdir(app.path);

    const templatePath = join(app.path, "fake-template.html");
    writeFileSync(templatePath, "<html><head></head><body><!--ssr-outlet--></body></html>");

    const rootPath = join(app.path, "src/pages/root.tsx");
    const indexPath = join(app.path, "src/pages/index.tsx");
    const blogSlugPath = join(app.path, "src/pages/blog/[slug].tsx");

    const [rootMod, indexMod, blogSlugMod] = await Promise.all([
      import(rootPath),
      import(indexPath),
      import(blogSlugPath),
    ]);

    __setCompileContext({
      rootPath,
      modules: {
        [rootPath]: rootMod,
        [indexPath]: indexMod,
        [blogSlugPath]: blogSlugMod,
      },
      routes: [
        { pattern: "/", path: indexPath, mode: "ssg" },
        { pattern: "/blog/:slug", path: blogSlugPath, mode: "ssg" },
      ],
      embedded: {
        template: templatePath,
        assets: {},
      },
    });

    const instance = await elyra({ pagesDir: join(app.path, "src/pages") });
    expect(instance).toBeInstanceOf(Elysia);
  }, 10_000);

  test("throws a clear error when no root.tsx is present", () => {
    const app = rememberTmpApp(createTmpApp("cli-app"));
    removeAppPath(app.path, "src/pages/root.tsx");
    writeAppFile(
      app.path,
      "src/pages/index.tsx",
      [
        'import { createRoute } from "elyra/client";',
        "const route = createRoute({ mode: 'ssg' });",
        "export default route.page({ component: () => <main>No root</main> });",
      ].join("\n")
    );
    writeAppFile(
      app.path,
      "src/pages/blog/[slug].tsx",
      [
        'import { createRoute } from "elyra/client";',
        "const route = createRoute({ mode: 'ssg' });",
        "export default route.page({",
        "  staticParams: () => [{ slug: 'hello-world' }],",
        "  component: () => <article>No root blog</article>,",
        "});",
      ].join("\n")
    );
    __setDevMode(true);
    process.chdir(app.path);

    expect(
      elyra({
        pagesDir: join(app.path, "src/pages"),
      })
    ).rejects.toThrow();
  });
});

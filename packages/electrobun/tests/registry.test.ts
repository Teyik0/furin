import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { startDesktopBackend } from "../src/runtime";
import { createDesktopApp } from "../src/server";

test("public source and bundled factory roots share the pure SDK controller registry", async () => {
  const root = await mkdtemp(join(tmpdir(), "furin-registry-bundle-"));
  const previousData = process.env.FURIN_APP_DATA_DIR;
  let first: Awaited<ReturnType<typeof startDesktopBackend>> | undefined;
  let second: Awaited<ReturnType<typeof startDesktopBackend>> | undefined;
  try {
    await mkdir(join(root, "node_modules"), { recursive: true });
    await symlink(
      dirname(dirname(Bun.resolveSync("elysia", import.meta.dir))),
      join(root, "node_modules/elysia"),
      "dir"
    );
    const sourceFactory = Bun.resolveSync("@teyik0/furin-electrobun/server", import.meta.dir);
    expect(sourceFactory).toEndWith("/src/server.ts");
    const factory = await Bun.build({
      entrypoints: [sourceFactory],
      external: ["elysia", "elysia/*"],
      target: "bun",
      format: "esm",
      outdir: join(root, "factory"),
    });
    const controller = await Bun.build({
      entrypoints: [join(import.meta.dir, "../src/runtime.ts")],
      target: "bun",
      format: "esm",
      outdir: join(root, "controller"),
      metafile: true,
    });
    expect(factory.success).toBe(true);
    expect(controller.success).toBe(true);
    expect(
      Object.keys(controller.metafile?.inputs ?? {}).some((path) => path.includes("elysia"))
    ).toBe(false);
    const bundledFactory: typeof import("../src/server") = await import(
      pathToFileURL(join(root, "factory/server.js")).href
    );
    const bundledController: typeof import("../src/runtime") = await import(
      pathToFileURL(join(root, "controller/runtime.js")).href
    );
    const sourceApp = createDesktopApp().get("/", () => "source");
    const bundledApp = bundledFactory.createDesktopApp().get("/", () => "bundle");
    first = await bundledController.startDesktopBackend(
      () => Promise.resolve({ default: sourceApp }),
      join(root, "source-data"),
      "build"
    );
    second = await startDesktopBackend(
      () => Promise.resolve({ default: bundledApp }),
      join(root, "bundle-data"),
      "build"
    );
    expect((await fetch(first.origin)).status).toBe(403);
    expect((await fetch(second.origin)).status).toBe(403);
    const one = await fetch(first.url, { redirect: "manual" });
    const two = await fetch(second.url, { redirect: "manual" });
    const cookieOne = one.headers.get("set-cookie")?.split(";")[0];
    const cookieTwo = two.headers.get("set-cookie")?.split(";")[0];
    if (!(cookieOne && cookieTwo)) {
      throw new Error("Missing registry-crossing cookies.");
    }
    expect(await (await fetch(first.origin, { headers: { cookie: cookieOne } })).text()).toBe(
      "source"
    );
    expect(await (await fetch(second.origin, { headers: { cookie: cookieTwo } })).text()).toBe(
      "bundle"
    );
    expect((await fetch(first.origin, { headers: { cookie: cookieTwo } })).status).toBe(403);
    expect((await fetch(second.origin, { headers: { cookie: cookieOne } })).status).toBe(403);
  } finally {
    try {
      await Promise.all([first?.stop(), second?.stop()]);
    } finally {
      if (previousData === undefined) {
        delete process.env.FURIN_APP_DATA_DIR;
      } else {
        process.env.FURIN_APP_DATA_DIR = previousData;
      }
      await rm(root, { recursive: true, force: true });
    }
  }
});

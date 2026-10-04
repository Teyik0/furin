import { expect, test } from "bun:test";
import { join } from "node:path";
import { createTmpApp, writeAppFile } from "../support/app-fixtures.ts";
import { getTestPort, waitForHttp } from "../support/http.ts";
import { runCli, startProcess } from "../support/process.ts";

function createApiPrerenderApp(mode: "isr" | "ssg") {
  const app = createTmpApp("cli-app-ssr");
  writeAppFile(
    app.path,
    "src/api.ts",
    `import Elysia from "elysia";
export const api = new Elysia().get("/api/message", () => ({ message: "In-memory API" }));`
  );
  writeAppFile(
    app.path,
    "src/pages/index.tsx",
    `import { defineRoute } from "@teyik0/furin";
import { createClient } from "@teyik0/furin/client";
import { api } from "../api";
import { route as rootRoute } from "./root";

export const route = defineRoute()
  .config({ layout: rootRoute, mode: ${JSON.stringify(mode)}, revalidate: 60 })
  .staticParams(() => [{}])
  .loader(async () => {
    const { data, error } = await createClient(api).api.message.get();
    if (error) throw error;
    return data;
  })
  .page(({ message }) => <main>{message}</main>);`
  );
  writeAppFile(
    app.path,
    "src/server.ts",
    `import { furin } from "@teyik0/furin";
import { api } from "./api";
export default api.use(await furin({ pagesDir: import.meta.dir + "/pages" }));`
  );
  return app;
}

test.each(["use", "setup"] as const)(
  "Vercel builds an API extended with .%s() after an in-memory ISR loader request",
  async (method) => {
    const app = createApiPrerenderApp("isr");
    try {
      if (method === "setup") {
        writeAppFile(
          app.path,
          "src/server.ts",
          `import { furin } from "@teyik0/furin";
import { api } from "./api";
export default api.setup(() => {}).use(await furin({ pagesDir: import.meta.dir + "/pages" }));`
        );
      }

      const build = await runCli(["build", "--target", "vercel"], { cwd: app.path });
      expect(build.exitCode, build.stderr).toBe(0);
      const fallbackPath = join(
        app.path,
        ".vercel/output/functions/index-isr.prerender-fallback.html"
      );
      expect(await Bun.file(fallbackPath).text()).toContain("In-memory API");
      const handlerPath = join(app.path, ".vercel/output/functions/__server.func/index.js");
      const handler = (await import(handlerPath)).default;
      const apiResponse = await handler.fetch(new Request("http://localhost/api/message"));
      expect(apiResponse.status).toBe(200);
      expect(await apiResponse.json()).toEqual({ message: "In-memory API" });
      const pageResponse = await handler.fetch(new Request("http://localhost/"));
      expect(pageResponse.status).toBe(200);
      expect(await pageResponse.text()).toContain("In-memory API");
    } finally {
      app.cleanup();
    }
  },
  30_000
);

test("Bun builds and serves an API extended after an in-memory SSG loader request", async () => {
  const app = createApiPrerenderApp("ssg");
  try {
    const build = await runCli(["build", "--target", "bun"], { cwd: app.path });
    expect(build.exitCode, build.stderr).toBe(0);
    const port = getTestPort();
    const server = startProcess([process.execPath, ".furin/build/bun/server.js"], {
      cwd: app.path,
      env: { PORT: String(port) },
    });
    try {
      const pageResponse = await waitForHttp(`http://localhost:${port}/`, { timeoutMs: 10_000 });
      expect(pageResponse.status).toBe(200);
      expect(await pageResponse.text()).toContain("In-memory API");
      const apiResponse = await fetch(`http://localhost:${port}/api/message`);
      expect(apiResponse.status).toBe(200);
      expect(await apiResponse.json()).toEqual({ message: "In-memory API" });
    } finally {
      server.kill();
      await server.exitCode;
    }
  } finally {
    app.cleanup();
  }
}, 30_000);

test("Vercel still rejects an API sealed inside the server entry itself", async () => {
  const app = createApiPrerenderApp("isr");
  try {
    writeAppFile(
      app.path,
      "src/server.ts",
      `import { furin } from "@teyik0/furin";
import { api } from "./api";
await api.handle(new Request("http://localhost/api/message"));
export default api.setup(() => {}).use(await furin({ pagesDir: import.meta.dir + "/pages" }));`
    );
    const build = await runCli(["build", "--target", "vercel"], { cwd: app.path });
    expect(build.exitCode).toBe(1);
    expect(build.stderr).toContain("[Elysia] .setup() called after the app was sealed");
  } finally {
    app.cleanup();
  }
}, 30_000);

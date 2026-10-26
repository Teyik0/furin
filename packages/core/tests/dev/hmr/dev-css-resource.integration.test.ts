// biome-ignore-all lint/performance/noAwaitInLoops: exercise edits while requests are in flight
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createTmpApp, writeAppFile } from "../../support/app-fixtures.ts";
import { getFreePort } from "../../support/hmr.ts";
import { waitForHttp } from "../../support/http.ts";
import { startProcess } from "../../support/process.ts";

test("CSS edits with incoming requests preserve an eagerly acquired server-only resource", async () => {
  const app = createTmpApp("cli-app");
  const port = await getFreePort();
  writeAppFile(app.path, "furin.config.ts", 'export default { serverEntry: "src/server.ts" };');
  writeAppFile(app.path, "src/styles.css", "body { color: red; }");
  writeAppFile(
    app.path,
    "src/pages/root.tsx",
    `import "../styles.css";\n${readFileSync(resolve(app.path, "src/pages/root.tsx"), "utf8")}`
  );
  writeAppFile(
    app.path,
    "src/resource.ts",
    `import "@teyik0/furin/server-only";
    import { openSync, closeSync, unlinkSync } from "node:fs";
    const path = import.meta.dir + "/instance.lock";
    const lock = openSync(path, "wx");
    console.log("RESOURCE ACQUIRED");
    export const resource = { value: "resource-ready", async dispose() {
      await Bun.sleep(200);
      closeSync(lock); unlinkSync(path);
      console.log("RESOURCE DISPOSED");
    } };`
  );
  writeAppFile(
    app.path,
    "src/pages/index.tsx",
    `import { defineRoute } from "@teyik0/furin";
    import { resource } from "../resource";
    export const route = defineRoute("/").config({ mode: "ssr" }).loader(() => ({ value: resource.value })).page(({ value }) => <main>{value}</main>);`
  );
  writeAppFile(
    app.path,
    "src/server.ts",
    `import { Elysia } from "elysia";
    import { furin } from "@teyik0/furin";
    import { resource } from "./resource";
    export default new Elysia().onStop(() => resource.dispose()).use(await furin({ pagesDir: import.meta.dir + "/pages" }));`
  );
  const server = startProcess(
    [
      process.execPath,
      resolve(import.meta.dir, "../../../src/cli/index.ts"),
      "dev",
      "--web",
      "--port",
      String(port),
    ],
    { cwd: app.path }
  );
  let requesting = true;
  let requests: Promise<void> | undefined;
  try {
    const url = `http://127.0.0.1:${port}/`;
    expect(await (await waitForHttp(url, {})).text()).toContain("resource-ready");
    requests = (async () => {
      while (requesting) {
        await fetch(url, { signal: AbortSignal.timeout(2000) })
          .then((response) => response.text())
          .catch(() => undefined);
        await Bun.sleep(25);
      }
    })();
    for (let edit = 0; edit < 8; edit += 1) {
      writeAppFile(app.path, "src/styles.css", `body { color: red; } /* ${edit} */`);
      await Bun.sleep(700);
    }
    await Bun.sleep(1000);
    expect(server.getStderr()).not.toContain("Failed to refresh route topology");
    expect(server.getStderr()).not.toContain("EEXIST");
    expect(server.getStdout().match(/RESOURCE ACQUIRED/g)).toHaveLength(1);
    expect(await (await fetch(url)).text()).toContain("resource-ready");
  } finally {
    requesting = false;
    await requests;
    server.kill();
    await server.exitCode;
    app.cleanup();
  }
}, 30_000);

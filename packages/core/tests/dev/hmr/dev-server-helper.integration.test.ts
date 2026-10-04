// biome-ignore-all lint/performance/noAwaitInLoops: observe HMR updates through HTTP polling
import { expect, test } from "bun:test";
import { join } from "node:path";
import { createTmpApp, writeAppFile } from "../../support/app-fixtures.ts";
import { getFreePort } from "../../support/hmr.ts";
import { waitForHttp } from "../../support/http.ts";
import { startProcess } from "../../support/process.ts";

test("editing a server-only composite helper refreshes cached SSG content without a restart", async () => {
  const app = createTmpApp("cli-app");
  const port = await getFreePort();
  const helper = (version: string): string =>
    `export function ServerCard() { return <article>server-card-${version}</article>; }`;
  writeAppFile(app.path, "src/components/server-card.tsx", helper("before"));
  writeAppFile(
    app.path,
    "src/pages/index.tsx",
    [
      'import { defineRoute } from "@teyik0/furin";',
      'import { CompositeComponent, createCompositeComponent } from "@teyik0/furin/rsc";',
      'import { ServerCard } from "../components/server-card";',
      'import { route as rootRoute } from "./root";',
      "export const route = defineRoute()",
      '  .config({ layout: rootRoute, mode: "ssg" })',
      "  .loader(async () => ({ card: await createCompositeComponent(() => <ServerCard />) }))",
      "  .page(({ card }) => <CompositeComponent src={card} />);",
    ].join("\n")
  );
  const server = startProcess(["bun", "--hot", join(app.path, "src/server.ts")], {
    cwd: app.path,
    env: { PORT: String(port) },
  });
  try {
    const url = `http://localhost:${port}/`;
    const initial = await waitForHttp(url, {}).catch((error: unknown) => {
      throw new Error(
        `Development server failed to become ready.\nstdout:\n${server.getStdout()}\nstderr:\n${server.getStderr()}`,
        { cause: error }
      );
    });
    expect(await initial.text()).toContain("server-card-before");
    const warm = await fetch(url);
    expect(await warm.text()).toContain("server-card-before");
    writeAppFile(app.path, "src/components/server-card.tsx", helper("after"));
    let html = "";
    for (let attempt = 0; attempt < 150; attempt += 1) {
      html = await (await fetch(url)).text();
      if (html.includes("server-card-after")) {
        break;
      }
      await Bun.sleep(100);
    }
    expect(html, server.getStderr()).toContain("server-card-after");
    expect(server.getStdout().match(/listening on/g)).toHaveLength(1);
  } finally {
    server.kill();
    await server.exitCode;
    app.cleanup();
  }
}, 30_000);

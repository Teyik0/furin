import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createTmpApp, removeAppPath } from "../support/app-fixtures.ts";
import { runCli } from "../support/process.ts";

interface ServerMetafile {
  outputs: {
    [path: string]: { inputs: { [path: string]: { bytesInOutput: number } } };
  };
}

function typeboxBytes(metafile: ServerMetafile): number {
  return Object.values(metafile.outputs).reduce(
    (total, output) =>
      total +
      Object.entries(output.inputs).reduce(
        (bytes, [path, input]) =>
          bytes + (path.includes("/node_modules/typebox/") ? input.bytesInOutput : 0),
        0
      ),
    0
  );
}

test("a Furin app without TypeBox schemas ships no TypeBox in its Vercel server chunks", async () => {
  const app = createTmpApp("cli-app-ssr");
  try {
    removeAppPath(app.path, "src/pages/blog/[slug].tsx");
    const result = await runCli(["build", "--target", "vercel", "--analyze"], { cwd: app.path });
    expect(result.exitCode).toBe(0);

    const metafile = JSON.parse(
      readFileSync(join(app.path, ".furin/build/analysis/vercel-server.json"), "utf8")
    ) as ServerMetafile;
    expect(typeboxBytes(metafile)).toBe(0);

    const handler = (
      await import(
        pathToFileURL(join(app.path, ".vercel/output/functions/__server.func/index.js")).href
      )
    ).default;
    expect((await handler.fetch(new Request("http://localhost/dashboard"))).status).toBe(200);
    expect(
      (await handler.fetch(new Request("http://localhost/_furin/data?path=%2Fdashboard"))).status
    ).toBe(200);
  } finally {
    app.cleanup();
  }
}, 30_000);

test("a Furin app without TypeBox schemas ships no TypeBox in its Bun server bundle", async () => {
  const app = createTmpApp("cli-app-ssr");
  try {
    removeAppPath(app.path, "src/pages/blog/[slug].tsx");
    const result = await runCli(["build", "--target", "bun", "--analyze"], { cwd: app.path });
    expect(result.exitCode).toBe(0);

    const metafile = JSON.parse(
      readFileSync(join(app.path, ".furin/build/analysis/bun-server.json"), "utf8")
    ) as ServerMetafile;
    expect(typeboxBytes(metafile)).toBe(0);
  } finally {
    app.cleanup();
  }
}, 30_000);

test("a Furin app with a TypeBox route still serves its navigation data", async () => {
  const app = createTmpApp("cli-app-ssr");
  try {
    const result = await runCli(["build", "--target", "vercel"], { cwd: app.path });
    expect(result.exitCode).toBe(0);

    const handler = (
      await import(
        pathToFileURL(join(app.path, ".vercel/output/functions/__server.func/index.js")).href
      )
    ).default;
    const response = await handler.fetch(
      new Request("http://localhost/_furin/data?path=%2Fblog%2Fhello-world")
    );
    expect(response.status).toBe(200);
  } finally {
    app.cleanup();
  }
}, 30_000);

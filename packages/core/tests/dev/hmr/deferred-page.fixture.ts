// biome-ignore-all lint/performance/noAwaitInLoops: route refresh polling must wait between requests
import { expect } from "bun:test";
import { type AnyElysia, Elysia } from "elysia";
import { furin } from "../../../src/furin.ts";
import { createTmpApp, writeAppFile } from "../../support/app-fixtures.ts";

const fixture = createTmpApp("cli-app-ssr");
const previousCwd = process.cwd();
let app: AnyElysia | undefined;
let contentLoads = 0;
const CONTENT_FILTER = /\.content$/;
async function waitForArticle(
  serverApp: AnyElysia,
  expected: string,
  status: number
): Promise<void> {
  const deadline = Date.now() + 3000;
  let actual = "";
  while (Date.now() < deadline) {
    const response = await serverApp.handle(new Request("http://localhost/article"));
    actual = await response.text();
    if (response.status === status && actual.includes(expected)) {
      return;
    }
    await Bun.sleep(20);
  }
  throw new Error(`Article did not reach ${status} with ${JSON.stringify(expected)}: ${actual}`);
}
Bun.plugin({
  name: "deferred-content-test",
  setup(build) {
    build.onLoad({ filter: CONTENT_FILTER }, async ({ path }) => {
      contentLoads += 1;
      const content = await Bun.file(path).text();
      if (content === "invalid content") {
        throw new Error("Content compilation failed");
      }
      return {
        contents: `export default function Content() { return ${JSON.stringify(content)}; }`,
        loader: "js",
      };
    });
  },
});
try {
  writeAppFile(fixture.path, "src/never.content", "invalid content");
  writeAppFile(
    fixture.path,
    "src/pages/redirect.tsx",
    `
    import { defineRoute } from "@teyik0/furin";
    import Never from "../never.content";
    import { route as rootRoute } from "./root";
    export const route = defineRoute().config({ layout: rootRoute, mode: "ssr" })
      .loader(({ redirect }) => { throw redirect("/"); })
      .page(() => <Never />);
  `
  );
  writeAppFile(fixture.path, "src/token.ts", 'export const token = "shared-";');
  writeAppFile(
    fixture.path,
    "src/shared.ts",
    `
    import { token } from "./token";
    Reflect.set(globalThis, "furinSharedLoads", (Reflect.get(globalThis, "furinSharedLoads") ?? 0) + 1);
    export const identity = token + Math.random();
  `
  );
  writeAppFile(
    fixture.path,
    "src/startup.ts",
    `
    Reflect.set(globalThis, "furinStartupLoads", (Reflect.get(globalThis, "furinStartupLoads") ?? 0) + 1);
  `
  );
  writeAppFile(fixture.path, "src/article.content", "First article version");
  writeAppFile(
    fixture.path,
    "src/pages/article.tsx",
    `
    import { defineRoute } from "@teyik0/furin";
    import Content from "../article.content";
    import { route as rootRoute } from "./root";
    export const route = defineRoute().config({ layout: rootRoute, mode: "ssr" })
      .page(() => <article><Content /></article>);
  `
  );
  writeAppFile(
    fixture.path,
    "src/heavy.tsx",
    `
    Reflect.set(globalThis, "furinHeavyLoads", (Reflect.get(globalThis, "furinHeavyLoads") ?? 0) + 1);
    export default function Heavy() { return <h1>Heavy page content</h1>; }
  `
  );
  writeAppFile(
    fixture.path,
    "src/pages/heavy.tsx",
    `
    import { defineRoute } from "@teyik0/furin";
    import { t } from "elysia";
    import Heavy from "../heavy";
    import { identity } from "../shared";
    import "../startup";
    import { route as rootRoute } from "./root";
    export const route = defineRoute().config({ layout: rootRoute, mode: "ssr", query: t.Object({ q: t.Optional(t.String({ minLength: 2 })) }) })
      .loader(() => ({ message: "loader intact", token: identity }))
      .page(({ message, token }) => <main><Heavy /><p>{message}</p><p>{token === identity ? "same identity" : "duplicated identity"}</p></main>);
  `
  );
  writeAppFile(
    fixture.path,
    "src/pages/index.tsx",
    `
    import { defineRoute } from "@teyik0/furin";
    import { route as rootRoute } from "./root";
    export const route = defineRoute().config({ layout: rootRoute, mode: "ssr" })
      .page(() => <h1>Light page content</h1>);
  `
  );
  process.chdir(fixture.path);
  app = new Elysia().use(await furin({ pagesDir: "./src/pages" }));
  expect(Reflect.get(globalThis, "furinHeavyLoads")).toBeUndefined();
  expect(contentLoads).toBe(0);
  expect(Reflect.get(globalThis, "furinSharedLoads")).toBe(1);
  expect(Reflect.get(globalThis, "furinStartupLoads")).toBe(1);
  const redirect = await app.handle(new Request("http://localhost/redirect"));
  expect(redirect.status).toBe(302);
  expect(redirect.headers.get("location")).toBe("/");
  expect(contentLoads).toBe(0);
  const invalid = await app.handle(new Request("http://localhost/heavy?q=x"));
  expect(invalid.status).toBe(422);
  const data = await app.handle(new Request("http://localhost/_furin/data?path=/heavy"));
  expect(data.status).toBe(200);
  expect(await data.text()).toContain("loader intact");
  expect(Reflect.get(globalThis, "furinHeavyLoads")).toBeUndefined();
  const light = await app.handle(new Request("http://localhost/"));
  expect(await light.text()).toContain("<h1>Light page content</h1>");
  expect(Reflect.get(globalThis, "furinHeavyLoads")).toBeUndefined();
  const responses = await Promise.all([
    app.handle(new Request("http://localhost/heavy")),
    app.handle(new Request("http://localhost/heavy")),
  ]);
  const bodies = await Promise.all(responses.map((response) => response.text()));
  for (const [index, response] of responses.entries()) {
    const html = bodies[index];
    expect(response.status).toBe(200);
    expect(html).toContain("<h1>Heavy page content</h1>");
    expect(html).toContain("<p>loader intact</p>");
    expect(html).toContain("<p>same identity</p>");
  }
  expect(Reflect.get(globalThis, "furinHeavyLoads")).toBe(1);
  expect(Reflect.get(globalThis, "furinSharedLoads")).toBe(1);
  expect(Reflect.get(globalThis, "furinStartupLoads")).toBe(1);
  const firstArticle = await app.handle(new Request("http://localhost/article"));
  expect(await firstArticle.text()).toContain("<article>First article version</article>");
  expect(contentLoads).toBe(1);
  writeAppFile(fixture.path, "src/article.content", "Updated article version");
  await waitForArticle(app, "<article>Updated article version</article>", 200);
  expect(contentLoads).toBe(2);
  writeAppFile(fixture.path, "src/article.content", "invalid content");
  await waitForArticle(app, "", 500);
  writeAppFile(fixture.path, "src/article.content", "Recovered article version");
  await waitForArticle(app, "<article>Recovered article version</article>", 200);
  expect(contentLoads).toBe(4);
  writeAppFile(fixture.path, "src/token.ts", 'export const token = "edited-";');
  const updatedShared = await app.handle(new Request("http://localhost/heavy"));
  expect(await updatedShared.text()).toContain("<p>same identity</p>");
} finally {
  await app?.stop();
  process.chdir(previousCwd);
  fixture.cleanup();
}

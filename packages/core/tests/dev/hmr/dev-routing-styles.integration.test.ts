// biome-ignore-all lint/performance/noAwaitInLoops: integration test polling must wait between retries
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { createTmpApp, type TmpApp, writeAppFile } from "../../support/app-fixtures.ts";
import { getFreePort } from "../../support/hmr.ts";
import { pollUntil } from "../../support/http.ts";
import { startProcess } from "../../support/process.ts";

const ROOT_LAYOUT = `import { defineRootRoute, HeadContent, Scripts } from "@teyik0/furin";
export const route = defineRootRoute()
  .config({ mode: "ssr" })
  .layout(({ children }) => <html lang="en"><head><HeadContent /></head><body>{children}<Scripts /></body></html>);`;

function layoutSource(id: string, version: string): string {
  return `import { defineRoute } from "@teyik0/furin";
export const route = defineRoute("${id}")
  .config({ mode: "ssr" })
  .layout(({ children }) => <section data-layout="${version}">{children}</section>);`;
}

function paramPageSource(id: string, param: string): string {
  return `import { defineRoute } from "@teyik0/furin";
import { t } from "elysia";
export const route = defineRoute("${id}")
  .config({ mode: "ssr", params: t.Object({ ${param}: t.String() }) })
  .page(({ params }) => <main data-param={params.${param}}>{params.${param}}</main>);`;
}

const HOME_PAGE = (id: string) => `import { defineRoute } from "@teyik0/furin";
export const route = defineRoute("${id}").config({ mode: "ssr" }).page(() => <main>Home</main>);`;

/** Boots `bun --hot` on the fixture app and serves `/` before the tests run. */
function devServer(app: TmpApp) {
  let port = 0;
  let server: ReturnType<typeof startProcess> | undefined;
  return {
    async start(): Promise<void> {
      port = await getFreePort();
      server = startProcess(["bun", "--hot", join(app.path, "src/server.ts")], {
        cwd: app.path,
        env: { PORT: String(port) },
      });
      const ready = await pollUntil(
        async () => {
          try {
            return (await fetch(`http://localhost:${port}/`)).ok;
          } catch {
            return false;
          }
        },
        80,
        250
      );
      if (!ready) {
        throw new Error(`Dev server failed to start. stderr:\n${server.getStderr()}`);
      }
    },
    async stop(): Promise<void> {
      server?.kill();
      await server?.exitCode;
      app.cleanup();
    },
    async html(path: string): Promise<string> {
      return await (await fetch(`http://localhost:${port}${path}`)).text();
    },
    async status(path: string): Promise<number> {
      return (await fetch(`http://localhost:${port}${path}`)).status;
    },
  };
}

async function waitForHtml(read: () => Promise<string>, marker: string): Promise<string> {
  let html = "";
  await pollUntil(
    async () => {
      html = await read();
      return html.includes(marker);
    },
    80,
    250
  );
  return html;
}

describe.serial("dev server — TanStack flat layouts", () => {
  const app = createTmpApp("cli-app");
  const dev = devServer(app);
  writeAppFile(app.path, "src/pages/__root.tsx", ROOT_LAYOUT);
  writeAppFile(app.path, "src/pages/index.tsx", HOME_PAGE("/"));
  writeAppFile(app.path, "src/pages/posts.tsx", layoutSource("/posts", "posts-v1"));
  writeAppFile(
    app.path,
    "src/pages/posts.$postId.tsx",
    paramPageSource("/posts/$postId", "postId")
  );

  beforeAll(() => dev.start(), 30_000);
  afterAll(() => dev.stop());

  test("posts.tsx wraps posts.$postId.tsx", async () => {
    const html = await dev.html("/posts/7");
    expect(html).toContain('data-layout="posts-v1"');
    expect(html).toContain('data-param="7"');
  });

  test("editing the flat layout repairs the page it wraps", async () => {
    writeAppFile(app.path, "src/pages/posts.tsx", layoutSource("/posts", "posts-v2"));
    const html = await waitForHtml(() => dev.html("/posts/7"), 'data-layout="posts-v2"');
    expect(html).toContain('data-layout="posts-v2"');
    expect(html).toContain('data-param="7"');
  });
});

describe.serial("dev server — Next.js App Router style", () => {
  const app = createTmpApp("cli-app");
  const dev = devServer(app);
  writeAppFile(
    app.path,
    "src/server.ts",
    `import { furin } from "@teyik0/furin";
import Elysia from "elysia";
const app = new Elysia().use(await furin({ pagesDir: \`\${import.meta.dir}/app\`, style: "nextjs" }));
app.listen(Number(process.env.PORT));`
  );
  writeAppFile(app.path, "src/app/layout.tsx", ROOT_LAYOUT);
  writeAppFile(app.path, "src/app/page.tsx", HOME_PAGE("/"));
  writeAppFile(app.path, "src/app/blog/layout.tsx", layoutSource("/blog", "blog-v1"));
  writeAppFile(app.path, "src/app/blog/[slug]/page.tsx", paramPageSource("/blog/$slug/", "slug"));
  writeAppFile(app.path, "src/app/blog/[slug]/card.tsx", "export const Card = () => null;");

  beforeAll(() => dev.start(), 30_000);
  afterAll(() => dev.stop());

  test("serves page.tsx inside its layout.tsx and ignores colocated files", async () => {
    const html = await dev.html("/blog/hello");
    expect(html).toContain('data-layout="blog-v1"');
    expect(html).toContain('data-param="hello"');
    expect(await dev.status("/blog/hello/card")).toBe(404);
  });

  test("editing a nested layout.tsx repairs the page it wraps", async () => {
    writeAppFile(app.path, "src/app/blog/layout.tsx", layoutSource("/blog", "blog-v2"));
    const html = await waitForHtml(() => dev.html("/blog/hello"), 'data-layout="blog-v2"');
    expect(html).toContain('data-param="hello"');
  });
});

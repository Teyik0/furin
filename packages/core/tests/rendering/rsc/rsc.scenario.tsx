import { expect } from "bun:test";
import { type Context, Elysia } from "elysia";
import { defer } from "furin/client";
import type { ReactNode } from "react";
import { renderToReadableStream } from "react-dom/server";
import { defineRootRoute, defineRoute, HeadContent, Scripts } from "../../../src/furin.ts";
import { renderSSR } from "../../../src/server/render/index.ts";
import { serializeLoaderDataNdjson } from "../../../src/server/render/ssr.ts";
import { adaptDefinedLayout, adaptDefinedPage } from "../../../src/server/router/defined-route.ts";
import { createDataEndpoint, createRoutePlugin } from "../../../src/server/router/plugin.ts";
import type { ResolvedRoute, RootLayout } from "../../../src/server/router/types.ts";
import { __setDevMode } from "../../../src/server/runtime-env.ts";
import { parseDeferredNdjson } from "../../../src/shared/deferred-ndjson.ts";
import { parseRouteFrameLines, serializeRouteFrames } from "../../../src/shared/route-frame.ts";
import { collectRouteChainFromRoute } from "../../../src/shared/utils/index.ts";

process.env.FURIN_RSC_CODEC_PATH = "";

type RenderServerComponent = (node: ReactNode) => Promise<ReactNode>;

const rootTerminal = defineRootRoute()
  .config({ mode: "ssr" })
  .layout(({ children }) => (
    <html lang="en">
      <head>
        <HeadContent />
      </head>
      <body>
        {children}
        <Scripts />
      </body>
    </html>
  ));
const root = {
  path: "/root.tsx",
  route: adaptDefinedLayout(rootTerminal, undefined),
} satisfies RootLayout;

function resolveRoute(
  route: Parameters<typeof adaptDefinedPage>[0],
  path: string,
  pattern: string
): ResolvedRoute {
  const page = adaptDefinedPage(route, root.route);
  return {
    mode: page.mode ?? "ssr",
    page,
    path,
    pattern,
    routeChain: collectRouteChainFromRoute(page._route),
    segmentBoundaries: [],
  };
}

function responseBody(response: Response): ReadableStream<Uint8Array> {
  if (response.body === null) {
    throw new Error("response body missing");
  }
  return response.body;
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(message));
    }, timeoutMs);

    promise.then(
      (value) => {
        clearTimeout(timeout);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timeout);
        reject(error);
      }
    );
  });
}

function renderFooter(label: string): ReactNode {
  return <button type="button">{label}</button>;
}

function ToolbarAction({ label }: { label: string }): ReactNode {
  return <button type="button">{label}</button>;
}

function createRscRoute(renderServerComponent: RenderServerComponent): {
  resolved: ResolvedRoute;
  root: RootLayout;
} {
  const route = defineRoute()
    .config({ layout: rootTerminal, mode: "ssr" })
    .loader(async () => ({ article: await renderServerComponent(<h1>Flight article</h1>) }))
    .page(({ data }) => <main>{data.article}</main>);
  const resolved = resolveRoute(route, "/rsc.tsx", "/rsc");
  return { resolved, root };
}

function createMockContext(path: string): Context {
  return {
    cookie: {},
    headers: {},
    params: {},
    path,
    query: {},
    redirect: (url: string) => new Response(null, { headers: { Location: url }, status: 302 }),
    request: new Request(`http://localhost${path}`),
    set: { headers: {} },
  } as unknown as Context;
}

function extractRouteFramePayload(html: string): string {
  const startMarker = '<template id="__FURIN_ROUTE_FRAMES__">';
  const start = html.indexOf(startMarker);
  if (start === -1) {
    throw new Error("route frame template missing");
  }
  const contentStart = start + startMarker.length;
  const contentEnd = html.indexOf("</template>", contentStart);
  if (contentEnd === -1) {
    throw new Error("route frame template was not closed");
  }
  return html.slice(contentStart, contentEnd).replaceAll("&lt;", "<").replaceAll("&amp;", "&");
}

function extractPushedRouteFrames(html: string): string {
  const marker = "window.__FURIN_ROUTE_FRAME_STREAM__.push(";
  const chunks: string[] = [];
  let offset = 0;
  for (;;) {
    const start = html.indexOf(marker, offset);
    if (start === -1) {
      return chunks.join("");
    }
    const valueStart = start + marker.length;
    const valueEnd = html.indexOf(")</script>", valueStart);
    if (valueEnd === -1) {
      throw new Error("route frame push script was not closed");
    }
    chunks.push(JSON.parse(html.slice(valueStart, valueEnd)) as string);
    offset = valueEnd + 1;
  }
}

async function renderHtml(node: unknown): Promise<string> {
  const stream = await renderToReadableStream(node as ReactNode);
  return new Response(stream).text();
}

try {
  __setDevMode(false);
  const { CompositeComponent, createCompositeComponent, renderServerComponent } = await import(
    "furin/rsc"
  );

  let article = await renderServerComponent(<h1>Composite RSC</h1>);
  expect(await renderHtml(<main>{article}</main>)).toBe("<main><h1>Composite RSC</h1></main>");

  article = await renderServerComponent(<h1>Transported RSC</h1>);
  let payload = await serializeLoaderDataNdjson({ article }, undefined);
  let response = new Response(payload);
  let parsedNdjson = await parseDeferredNdjson(responseBody(response), undefined);
  expect(await renderHtml(<main>{parsedNdjson.syncData.article as ReactNode}</main>)).toBe(
    "<main><h1>Transported RSC</h1></main>"
  );

  article = await renderServerComponent(<h1>Buffered Flight article</h1>);
  payload = await serializeLoaderDataNdjson(
    { content: { article } },
    { slow: Promise.resolve("done") }
  );
  response = new Response(payload);
  parsedNdjson = await parseDeferredNdjson(responseBody(response), undefined);
  const bufferedContent = parsedNdjson.syncData.content as { article: ReactNode };
  expect(await renderHtml(bufferedContent.article)).toBe("<h1>Buffered Flight article</h1>");
  expect(await parsedNdjson.deferredPromises.slow).toBe("done");

  const firstLine = serializeRouteFrames({ title: "ready" }, undefined).trimEnd();
  let parsedFrames = await parseRouteFrameLines(firstLine, () =>
    Promise.reject(new Error("stream failed"))
  );
  expect(parsedFrames.syncData.title).toBe("ready");
  await expect(parsedFrames.completion).rejects.toThrow("stream failed");

  article = await renderServerComponent(<h1>Cyclic Flight article</h1>);
  const data: { article: ReactNode; self?: unknown } = { article };
  data.self = data;
  const lines = serializeRouteFrames(data, undefined).trimEnd().split("\n");
  const cyclicFirstLine = lines.shift();
  if (cyclicFirstLine === undefined) {
    throw new Error("route frame payload was empty");
  }
  parsedFrames = await parseRouteFrameLines(cyclicFirstLine, async () => lines.shift());
  expect(parsedFrames.syncData.self).toBe(parsedFrames.syncData);
  expect(await renderHtml(parsedFrames.syncData.article)).toBe("<h1>Cyclic Flight article</h1>");

  let routeFixture = createRscRoute(renderServerComponent);
  let app = new Elysia().use(createRoutePlugin(routeFixture.resolved, routeFixture.root));
  let html = await app.handle(new Request("http://localhost/rsc")).then((res) => res.text());
  expect(html).toContain("Flight article");
  expect(html).toContain('id="__FURIN_ROUTE_FRAMES__"');

  const nestedSsrRoute = defineRoute()
    .config({ layout: rootTerminal, mode: "ssr" })
    .loader(async () => ({
      content: { article: await renderServerComponent(<h1>SSR Nested Flight article</h1>) },
    }))
    .page(({ data: loaderData }) => <main>{loaderData.content.article}</main>);
  let nestedSsrResolved = resolveRoute(nestedSsrRoute, "/ssr-nested-rsc.tsx", "/ssr-nested-rsc");
  response = await renderSSR(
    nestedSsrResolved,
    createMockContext("/ssr-nested-rsc"),
    routeFixture.root,
    undefined
  );
  html = await response.text();
  payload = extractRouteFramePayload(html);
  parsedNdjson = await parseDeferredNdjson(new Blob([payload]).stream(), undefined);
  const nestedSsrContent = parsedNdjson.syncData.content as { article: ReactNode };
  expect(await renderHtml(nestedSsrContent.article)).toBe("<h1>SSR Nested Flight article</h1>");

  routeFixture = createRscRoute(renderServerComponent);
  app = new Elysia().use(createDataEndpoint([routeFixture.resolved]));
  response = await app.handle(new Request("http://localhost/_furin/data?path=%2Frsc"));
  parsedNdjson = await parseDeferredNdjson(responseBody(response), undefined);
  expect(await renderHtml(parsedNdjson.syncData.article)).toBe("<h1>Flight article</h1>");

  let resolveSlow: ((value: string) => void) | undefined;
  const slow = new Promise<string>((resolve) => {
    resolveSlow = resolve;
  });
  const route = defineRoute()
    .config({ layout: rootTerminal, mode: "ssr" })
    .loader(async () =>
      defer({
        content: { article: await renderServerComponent(<h1>Nested Flight article</h1>) },
        slow,
      })
    )
    .page(() => null);
  const resolved = resolveRoute(route, "/nested-rsc.tsx", "/nested-rsc");
  app = new Elysia().use(createDataEndpoint([resolved]));
  response = await app.handle(new Request("http://localhost/_furin/data?path=%2Fnested-rsc"));

  expect(response.headers.get("content-type")).toBe("application/x-furin-route");
  const parsedRace = await withTimeout(
    parseDeferredNdjson(responseBody(response), undefined),
    2000,
    "route frame parser waited for deferred data"
  );
  const nestedContent = parsedRace.syncData.content as { article: ReactNode };
  expect(await renderHtml(nestedContent.article)).toBe("<h1>Nested Flight article</h1>");
  if (resolveSlow === undefined) {
    throw new Error("slow resolver was not initialized");
  }
  resolveSlow("done");
  expect(await parsedRace.deferredPromises.slow).toBe("done");

  const deferredRscRoute = defineRoute()
    .config({ layout: rootTerminal, mode: "ssr" })
    .loader(async () =>
      defer({
        readyArticle: await renderServerComponent(<h1>Ready Flight article</h1>),
        slowArticle: renderServerComponent(<h1>Deferred Flight article</h1>),
      })
    )
    .page(() => null);
  const deferredRscResolved = resolveRoute(deferredRscRoute, "/deferred-rsc.tsx", "/deferred-rsc");
  app = new Elysia().use(createDataEndpoint([deferredRscResolved]));
  response = await app.handle(new Request("http://localhost/_furin/data?path=%2Fdeferred-rsc"));
  parsedNdjson = await parseDeferredNdjson(responseBody(response), undefined);
  expect(await renderHtml(parsedNdjson.syncData.readyArticle)).toBe(
    "<h1>Ready Flight article</h1>"
  );
  expect(await renderHtml(await parsedNdjson.deferredPromises.slowArticle)).toBe(
    "<h1>Deferred Flight article</h1>"
  );

  const deferredOnlyRscRoute = defineRoute()
    .config({ layout: rootTerminal, mode: "ssr" })
    .loader(async () =>
      defer({
        slowArticle: Promise.resolve(
          await renderServerComponent(<h1>SSR Deferred Flight article</h1>)
        ),
        title: "deferred only",
      })
    )
    .page(() => null);
  nestedSsrResolved = resolveRoute(
    deferredOnlyRscRoute,
    "/ssr-deferred-rsc.tsx",
    "/ssr-deferred-rsc"
  );
  response = await renderSSR(
    nestedSsrResolved,
    createMockContext("/ssr-deferred-rsc"),
    routeFixture.root,
    undefined
  );
  html = await response.text();
  payload = extractRouteFramePayload(html) + extractPushedRouteFrames(html);
  parsedNdjson = await parseDeferredNdjson(new Blob([payload]).stream(), undefined);
  expect(parsedNdjson.syncData.title).toBe("deferred only");
  expect(await renderHtml(await parsedNdjson.deferredPromises.slowArticle)).toBe(
    "<h1>SSR Deferred Flight article</h1>"
  );

  const Card = await createCompositeComponent<{
    children?: ReactNode;
    footer: (label: string) => ReactNode;
  }>(({ children, footer }) => (
    <article>
      {children}
      <footer>{footer("Loaded")}</footer>
    </article>
  ));

  expect(
    await renderHtml(
      <CompositeComponent footer={renderFooter} src={Card}>
        <h2>Profile</h2>
      </CompositeComponent>
    )
  ).toBe(
    '<article><h2>Profile</h2><footer><button type="button">Loaded</button></footer></article>'
  );

  const Toolbar = await createCompositeComponent<{
    Action: (props: { label: string }) => ReactNode;
  }>(({ Action }) => (
    <nav>
      <Action label="Save" />
    </nav>
  ));

  expect(await renderHtml(<CompositeComponent Action={ToolbarAction} src={Toolbar} />)).toBe(
    '<nav><button type="button">Save</button></nav>'
  );
  self.postMessage({ type: "pass" });
} catch (error) {
  self.postMessage({
    message: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : undefined,
    type: "fail",
  });
}

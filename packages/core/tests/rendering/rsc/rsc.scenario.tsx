import { expect } from "bun:test";
import { type Context, Elysia } from "elysia";
import { defer } from "furin/client";
import {
  act,
  createElement,
  isValidElement,
  type ReactElement,
  type ReactNode,
  useState,
} from "react";
import { createRoot } from "react-dom/client";
import { renderToReadableStream } from "react-dom/server";
import { defineRootRoute, defineRoute, HeadContent, Scripts } from "../../../src/furin.ts";
import { renderSSR } from "../../../src/server/render/index.ts";
import { renderForPath, serializeLoaderDataNdjson } from "../../../src/server/render/ssr.ts";
import { adaptDefinedLayout, adaptDefinedPage } from "../../../src/server/router/defined-route.ts";
import { createDataEndpoint, createRoutePlugin } from "../../../src/server/router/plugin.ts";
import type { ResolvedRoute, RootLayout } from "../../../src/server/router/types.ts";
import { __setDevMode } from "../../../src/server/runtime-env.ts";
import { parseDeferredNdjson } from "../../../src/shared/deferred-ndjson.ts";
import { parseRouteFrameLines, serializeRouteFrames } from "../../../src/shared/route-frame.ts";
import { collectRouteChainFromRoute } from "../../../src/shared/utils/index.ts";
import { installDom, resetDomState, uninstallDom, waitForDom } from "../../support/dom.ts";
import "../../setup/global.ts";

process.env.FURIN_RSC_CODEC_PATH = "";

type RenderServerComponent = (node: ReactNode) => Promise<ReactNode>;

const ROUTE_FRAME_TEMPLATE_PATTERN =
  /<template\b(?=[^>]*\sid="__FURIN_ROUTE_FRAMES__"(?:\s|>))[^>]*>/;

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

function renderHydratedFooter(label: string): ReactNode {
  return <button type="button">{`${label} after hydration`}</button>;
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
    .page(({ article }) => <main>{article}</main>);
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
  const openingTag = ROUTE_FRAME_TEMPLATE_PATTERN.exec(html);
  // biome-ignore lint/suspicious/noUnnecessaryConditions: rendered HTML can lack the route frame template.
  if (openingTag === null) {
    throw new Error("route frame template missing");
  }
  const contentStart = openingTag.index + openingTag[0].length;
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

  expect(
    extractRouteFramePayload(
      '<template data-id=\'id="__FURIN_ROUTE_FRAMES__"\'>decoy</template><template id="__FURIN_ROUTE_FRAMES__">payload</template>'
    )
  ).toBe("payload");

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
    .page(({ content }) => <main>{content.article}</main>);
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

  interface SlotData {
    flags: boolean[];
    self?: SlotData;
  }
  const slotData: SlotData = { flags: [false, true] };
  slotData.self = slotData;
  let previousSlotData: SlotData | undefined;
  const Nested = await createCompositeComponent<{
    Wrapper: (props: { children: ReactNode; data: SlotData }) => ReactNode;
    Action: (props: { label: string }) => ReactNode;
  }>(({ Wrapper, Action }) => (
    <Wrapper data={slotData}>
      <span>
        <Action label="Nested action" />
      </span>
    </Wrapper>
  ));
  expect(
    await renderHtml(
      <CompositeComponent
        Action={({ label }) => <button type="button">{label}</button>}
        src={Nested}
        Wrapper={({ children, data: receivedData }) => {
          expect(receivedData.flags).toEqual([false, true]);
          expect(receivedData.self).toBe(receivedData);
          if (previousSlotData !== undefined) {
            expect(receivedData).toBe(previousSlotData);
          }
          previousSlotData = receivedData;
          return <aside>{children}</aside>;
        }}
      />
    )
  ).toBe('<aside><span><button type="button">Nested action</button></span></aside>');
  await renderHtml(
    <CompositeComponent
      Action={({ label }) => <button type="button">{label}</button>}
      src={Nested}
      Wrapper={({ children, data: receivedData }) => {
        expect(previousSlotData).toBe(receivedData);
        return <aside>{children}</aside>;
      }}
    />
  );

  let previousIconData: SlotData | undefined;
  const IconProps = await createCompositeComponent<{
    Action: (props: { label: string }) => ReactNode;
    Wrapper: (props: { data: SlotData; item: ReactElement<{ icon: ReactNode }> }) => ReactNode;
  }>(({ Action, Wrapper }) => (
    <Wrapper
      data={slotData}
      item={createElement("span", {
        icon: Action({ label: "Icon action" }),
      })}
    />
  ));
  const renderIconProps = () =>
    renderHtml(
      <CompositeComponent
        Action={({ label }) => <button type="button">{label}</button>}
        src={IconProps}
        Wrapper={({ data: receivedData, item }) => {
          expect(receivedData.flags).toEqual([false, true]);
          expect(receivedData.self).toBe(receivedData);
          if (previousIconData !== undefined) {
            expect(receivedData).toBe(previousIconData);
          }
          previousIconData = receivedData;
          return <aside>{item.props.icon}</aside>;
        }}
      />
    );
  expect(await renderIconProps()).toBe('<aside><button type="button">Icon action</button></aside>');
  expect(await renderIconProps()).toBe('<aside><button type="button">Icon action</button></aside>');

  const SharedElement = await createCompositeComponent<{
    Action: () => ReactNode;
    Empty: () => ReactNode;
    Wrapper: (props: {
      emptyFirst: ReactNode;
      emptySecond: ReactNode;
      first: ReactNode;
      second: ReactNode;
    }) => ReactNode;
  }>(({ Action, Empty, Wrapper }) => {
    const shared = <span>{Action()}</span>;
    const empty = Empty();
    return Wrapper({ emptyFirst: empty, emptySecond: empty, first: shared, second: shared });
  });
  let sharedActionCalls = 0;
  let sharedEmptyCalls = 0;
  expect(
    await renderHtml(
      <CompositeComponent
        Action={() => {
          sharedActionCalls += 1;
          return <button type="button">Shared action</button>;
        }}
        Empty={() => {
          sharedEmptyCalls += 1;
        }}
        src={SharedElement}
        Wrapper={({ emptyFirst, emptySecond, first, second }) => {
          expect(emptyFirst).toBeUndefined();
          expect(emptySecond).toBeUndefined();
          expect(first).toBe(second);
          return <aside>{first}</aside>;
        }}
      />
    )
  ).toBe('<aside><span><button type="button">Shared action</button></span></aside>');
  expect(sharedActionCalls).toBe(1);
  expect(sharedEmptyCalls).toBe(1);

  await Promise.all(
    [true, false].map(async (explicitKey) => {
      const Keyed = await createCompositeComponent<{
        Wrapper: (props: { children: ReactNode }) => ReactNode;
        Action: (props: { label: string }) => ReactNode;
      }>(({ Wrapper, Action }) => (
        <Wrapper>
          <Action key={explicitKey ? "1" : undefined} label="First" />
          <Action label="Second" />
        </Wrapper>
      ));
      expect(
        await renderHtml(
          <CompositeComponent
            Action={({ label }) => (
              <button key={label === "First" ? "1" : undefined} type="button">
                {label}
              </button>
            )}
            src={Keyed}
            Wrapper={({ children }) => {
              const nodes = (Array.isArray(children) ? children : [children]).filter(
                isValidElement
              );
              expect(nodes).toHaveLength(2);
              expect(new Set(nodes.map((node) => node.key)).size).toBe(2);
              return <aside>{children}</aside>;
            }}
          />
        )
      ).toBe(
        '<aside><button type="button">First</button><button type="button">Second</button></aside>'
      );
    })
  );

  const KeyedCounter = await createCompositeComponent<{
    Counter: () => ReactNode;
  }>(({ Counter }) => <Counter key="stable-marker" />);
  function ClientCounter() {
    const [count, setCount] = useState(0);
    return (
      <button onClick={() => setCount((current) => current + 1)} type="button">
        {count}
      </button>
    );
  }
  installDom();
  resetDomState();
  const container = document.createElement("div");
  document.body.appendChild(container);
  const clientRoot = createRoot(container);
  try {
    await act(() => {
      clientRoot.render(
        <CompositeComponent Counter={() => <ClientCounter key="first" />} src={KeyedCounter} />
      );
    });
    await waitForDom(() => container.textContent === "0", { timeoutMs: 2000 });
    await act(() => {
      container.querySelector("button")?.click();
    });
    expect(container.textContent).toBe("1");
    await act(() => {
      clientRoot.render(
        <CompositeComponent Counter={() => <ClientCounter key="second" />} src={KeyedCounter} />
      );
    });
    expect(container.textContent).toBe("0");

    const markerCounters = (names: string[]) =>
      createCompositeComponent<{
        Item: () => ReactNode;
        Wrapper: (props: { children: ReactNode }) => ReactNode;
      }>(({ Item, Wrapper }) => (
        <Wrapper>
          {names.map((name) => (
            <Item key={name} />
          ))}
        </Wrapper>
      ));
    const initialCounters = await markerCounters(["first", "second"]);
    const reorderedCounters = await markerCounters(["second", "first"]);
    await act(() => {
      clientRoot.render(
        <CompositeComponent
          Item={() => <ClientCounter />}
          src={initialCounters}
          Wrapper={({ children }) => <aside>{children}</aside>}
        />
      );
    });
    await act(() => container.querySelector("button")?.click());
    expect([...container.querySelectorAll("button")].map((button) => button.textContent)).toEqual([
      "1",
      "0",
    ]);
    await act(() => {
      clientRoot.render(
        <CompositeComponent
          Item={() => <ClientCounter />}
          src={reorderedCounters}
          Wrapper={({ children }) => <aside>{children}</aside>}
        />
      );
    });
    expect([...container.querySelectorAll("button")].map((button) => button.textContent)).toEqual([
      "0",
      "1",
    ]);
    await act(() => {
      clientRoot.render(
        <CompositeComponent
          Item={() => <ClientCounter key="changed-result" />}
          src={reorderedCounters}
          Wrapper={({ children }) => <aside>{children}</aside>}
        />
      );
    });
    expect(container.textContent).toBe("00");
  } finally {
    act(() => clientRoot.unmount());
    await uninstallDom();
  }

  for (const mode of ["ssg", "isr"] as const) {
    const bufferedRoute =
      mode === "isr"
        ? defineRoute()
            .config({ layout: rootTerminal, mode: "isr", revalidate: 300 })
            .loader(async () => ({
              article: await renderServerComponent(<h1>Buffered article</h1>),
              shell: Card,
            }))
            .page(({ article: pageArticle, shell }) => (
              <>
                <CompositeComponent footer={renderFooter} src={shell} />
                {pageArticle}
              </>
            ))
        : defineRoute()
            .config({ layout: rootTerminal, mode: "ssg" })
            .loader(async () => ({
              article: await renderServerComponent(<h1>Buffered article</h1>),
              shell: Card,
            }))
            .page(({ article: pageArticle, shell }) => (
              <>
                <CompositeComponent footer={renderFooter} src={shell} />
                {pageArticle}
              </>
            ));
    const bufferedResolved = resolveRoute(bufferedRoute, `/${mode}-rsc.tsx`, `/${mode}-rsc`);
    // biome-ignore lint/performance/noAwaitInLoops: each render is checked before the next mode.
    const result = await renderForPath(bufferedResolved, {}, root, "http://localhost", mode);
    if (result instanceof Response) {
      throw new Error("buffered RSC route returned a redirect");
    }
    expect(result.html).toContain('<article><footer><button type="button">Loaded</button>');
    expect(result.html).toContain("<h1>Buffered article</h1>");
    const initialData = await parseDeferredNdjson(
      new Blob([extractRouteFramePayload(result.html)]).stream(),
      undefined
    );
    expect(
      await renderHtml(
        <CompositeComponent
          footer={renderHydratedFooter}
          src={initialData.syncData.shell as typeof Card}
        />
      )
    ).toContain('<button type="button">Loaded after hydration</button>');
    expect(await renderHtml(initialData.syncData.article)).toBe("<h1>Buffered article</h1>");
  }

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

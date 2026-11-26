import { expect, test } from "bun:test";
import { t } from "elysia";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { RouterProvider, useRouter } from "../../../src/client/link.tsx";
import type { ClientSegmentBoundary, LoadedClientRoute } from "../../../src/client/router/types.ts";
import { defineRootRoute, defineRoute } from "../../../src/define-route.ts";
import { adaptDefinedLayout, adaptDefinedPage } from "../../../src/server/router/defined-route.ts";
import { useDomTests } from "../../support/dom.ts";
import { makeNdjsonResponse, navigationDataPath } from "../../support/navigation-data.ts";

useDomTests();

const PRODUCTS_PATTERN = /^\/products$/;
const ORDERS_PATTERN = /^\/orders$/;

function Skeleton() {
  return <p>Loading products</p>;
}

/** `/products` sits under the root layout; `/orders`, when given boundaries, under its own layout too. */
async function mountProducts(
  boundaries: ClientSegmentBoundary[],
  ordersBoundaries: ClientSegmentBoundary[]
) {
  let router: ReturnType<typeof useRouter> | undefined;
  const layout = defineRootRoute()
    .config({ mode: "ssr" })
    .layout(({ children }) => <section>{children}</section>);
  const products = defineRoute("/definition")
    .config({ mode: "ssr", query: t.Object({ q: t.String() }) })
    .page(({ query }) => {
      router = useRouter();
      return <output>{query.q}</output>;
    });
  const rootLayout = adaptDefinedLayout(layout, undefined);
  const page = adaptDefinedPage(products, rootLayout);
  const ordersLayout = defineRoute("/definition")
    .config({ mode: "ssr" })
    .layout(({ children }) => <article>{children}</article>);
  const orders = adaptDefinedPage(
    defineRoute("/definition")
      .config({ mode: "ssr" })
      .page(() => <output>orders</output>),
    adaptDefinedLayout(ordersLayout, rootLayout)
  );
  const ordersMatch: LoadedClientRoute = {
    component: orders.component,
    load: () => Promise.resolve({ default: orders, segmentBoundaries: ordersBoundaries }),
    pageRoute: orders._route,
    pattern: "/orders",
    regex: ORDERS_PATTERN,
  };
  const match: LoadedClientRoute = {
    component: page.component,
    load: () => Promise.resolve({ default: page, segmentBoundaries: boundaries }),
    pageRoute: page._route,
    pattern: "/products",
    regex: PRODUCTS_PATTERN,
    segmentBoundaries: boundaries,
  };
  window.history.replaceState(null, "", "/products?q=a");
  const responses = new Map<string, PromiseWithResolvers<Response>>();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = ((input: RequestInfo | URL) => {
    const href = navigationDataPath(input, window.location.origin) ?? String(input);
    const response = Promise.withResolvers<Response>();
    responses.set(href, response);
    return response.promise;
  }) as typeof fetch;
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(() =>
    root.render(
      <RouterProvider
        autoRefresh={false}
        basePath=""
        defaultPreload={false}
        defaultPreloadDelay={50}
        defaultPreloadStaleTime={30_000}
        initialData={{ query: { q: "a" } }}
        initialDigest={undefined}
        initialMatch={match}
        prefetchCacheSize={50}
        root={null}
        routes={[match, ordersMatch]}
      />
    )
  );
  if (!router) {
    throw new Error("Router did not mount");
  }
  return {
    container,
    match,
    router,
    respond(href: string) {
      responses
        .get(href)
        ?.resolve(
          makeNdjsonResponse({ query: { q: new URL(href, "http://x").searchParams.get("q") } })
        );
    },
    async cleanup() {
      await act(() => root.unmount());
      container.remove();
      globalThis.fetch = originalFetch;
    },
  };
}

test("a slow loader shows the route's pending screen inside the shared layouts", async () => {
  const app = await mountProducts(
    [{ depth: 0, pending: { component: Skeleton, minMs: 0, ms: 20 } }],
    []
  );
  try {
    let navigation: Promise<void> | undefined;
    await act(async () => {
      navigation = app.router.navigate("/products?q=b" as string);
      await Bun.sleep(40);
    });
    expect(app.container.innerHTML).toBe("<section><p>Loading products</p></section>");
    await act(async () => {
      app.respond("/products?q=b");
      await navigation;
    });
    expect(app.container.innerHTML).toBe("<section><output>b</output></section>");
  } finally {
    await app.cleanup();
  }
});

test("a shown pending screen stays up for its minMs", async () => {
  const app = await mountProducts(
    [{ depth: 0, pending: { component: Skeleton, minMs: 120, ms: 0 } }],
    []
  );
  try {
    await act(async () => {
      app.router.navigate("/products?q=b" as string);
      await Bun.sleep(20);
      app.respond("/products?q=b");
      await Bun.sleep(40);
    });
    expect(app.container.textContent).toBe("Loading products");
    await act(() => Bun.sleep(120));
    expect(app.container.textContent).toBe("b");
  } finally {
    await app.cleanup();
  }
});

test("a loader faster than ms never shows the pending screen", async () => {
  const app = await mountProducts(
    [{ depth: 0, pending: { component: Skeleton, minMs: 0, ms: 60 } }],
    []
  );
  const rendered: string[] = [];
  const observer = new MutationObserver(() => rendered.push(app.container.textContent ?? ""));
  observer.observe(app.container, { characterData: true, childList: true, subtree: true });
  try {
    await act(async () => {
      const navigation = app.router.navigate("/products?q=b" as string);
      await Bun.sleep(10);
      app.respond("/products?q=b");
      await navigation;
      await Bun.sleep(80);
    });
    expect(rendered).not.toContain("Loading products");
    expect(app.container.textContent).toBe("b");
  } finally {
    observer.disconnect();
    await app.cleanup();
  }
});

test("refresh keeps the current page instead of the pending screen", async () => {
  const app = await mountProducts(
    [{ depth: 0, pending: { component: Skeleton, minMs: 0, ms: 0 } }],
    []
  );
  try {
    await act(async () => {
      app.router.refresh();
      await Bun.sleep(30);
    });
    expect(app.container.textContent).toBe("a");
    await act(async () => {
      app.respond("/products?q=a");
      await Bun.sleep(10);
    });
  } finally {
    await app.cleanup();
  }
});

test("a pending screen shows only inside a layout already on screen", async () => {
  const app = await mountProducts(
    [],
    [
      { depth: 0, pending: { component: () => <p>Root pending</p>, minMs: 0, ms: 0 } },
      { depth: 1, pending: { component: () => <p>Orders pending</p>, minMs: 0, ms: 0 } },
    ]
  );
  try {
    await act(async () => {
      app.router.navigate("/orders" as string);
      await Bun.sleep(30);
    });
    expect(app.container.innerHTML).toBe("<section><p>Root pending</p></section>");
    await act(async () => {
      app.respond("/orders");
      await Bun.sleep(10);
    });
    expect(app.container.innerHTML).toBe(
      "<section><article><output>orders</output></article></section>"
    );
  } finally {
    await app.cleanup();
  }
});

test("a layout's pending screen does not replace it during navigations inside it", async () => {
  const app = await mountProducts(
    [{ depth: 0, pending: { component: Skeleton, minMs: 0, ms: 0 } }],
    [{ depth: 0, pending: { component: () => <p>Root pending</p>, minMs: 0, ms: 0 } }]
  );
  try {
    await act(async () => {
      app.router.navigate("/orders" as string);
      await Bun.sleep(10);
      app.respond("/orders");
      await Bun.sleep(10);
    });
    await act(async () => {
      app.router.navigate("/orders?page=2" as string);
      await Bun.sleep(30);
    });
    expect(app.container.textContent).toBe("orders");
    await act(async () => {
      app.respond("/orders?page=2");
      await Bun.sleep(10);
    });
  } finally {
    await app.cleanup();
  }
});

test("the pending delay runs while the route module loads", async () => {
  const app = await mountProducts(
    [{ depth: 0, pending: { component: Skeleton, minMs: 0, ms: 60 } }],
    []
  );
  const { load } = app.match;
  app.match.load = () => Bun.sleep(60).then(load);
  try {
    await act(async () => {
      app.router.navigate("/products?q=b" as string);
      await Bun.sleep(100);
    });
    expect(app.container.textContent).toBe("Loading products");
    await act(async () => {
      app.respond("/products?q=b");
      await Bun.sleep(10);
    });
  } finally {
    await app.cleanup();
  }
});

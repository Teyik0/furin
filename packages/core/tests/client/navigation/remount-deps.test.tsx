import { expect, test } from "bun:test";
import { t } from "elysia";
import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { toCrossJSON } from "seroval";
import { RouterProvider, useRouter } from "../../../src/client/link.tsx";
import type { LoadedClientRoute } from "../../../src/client/router/types.ts";
import { defineRootRoute, defineRoute } from "../../../src/define-route.ts";
import { adaptDefinedLayout, adaptDefinedPage } from "../../../src/server/router/defined-route.ts";
import { useDomTests } from "../../support/dom.ts";

useDomTests();

const DOCUMENT_PATTERN = /^\/remount-doc\/[^/]+\/[^/]+$/;

async function mountRouter(
  remountDeps:
    | ((context: {
        params: { documentId: string; tab: string };
        query: { view: string };
      }) => readonly (string | number | boolean | null | undefined)[])
    | undefined
) {
  let router: ReturnType<typeof useRouter> | undefined;
  const layout = defineRootRoute()
    .config({ mode: "ssr" })
    .layout(({ children }) => {
      const [count, setCount] = useState(0);
      return (
        <section>
          <button onClick={() => setCount((value) => value + 1)} type="button">
            Layout {count}
          </button>
          {children}
        </section>
      );
    });
  const definition = defineRoute()
    .config({
      layout,
      mode: "ssr",
      params: t.Object({ documentId: t.String(), tab: t.String() }),
      query: t.Object({ view: t.String() }),
      remountDeps,
    })
    .page(({ params, query }) => {
      router = useRouter();
      const [count, setCount] = useState(0);
      return (
        <main>
          <output>{`${params.documentId}:${params.tab}:${query.view}`}</output>
          <button onClick={() => setCount((value) => value + 1)} type="button">
            Page {count}
          </button>
        </main>
      );
    });
  const rootLayout = adaptDefinedLayout(layout, undefined);
  const page = adaptDefinedPage(definition, rootLayout);
  const match: LoadedClientRoute = {
    component: page.component,
    load: () => Promise.resolve({ default: page }),
    pageRoute: page._route,
    pattern: "/remount-doc/:documentId/:tab",
    regex: DOCUMENT_PATTERN,
  };
  const initialData = {
    params: { documentId: "one", tab: "edit" },
    query: { view: "grid" },
  };
  window.history.replaceState(null, "", "/remount-doc/one/edit?view=grid");
  const originalFetch = globalThis.fetch;
  globalThis.fetch = ((input: RequestInfo | URL) => {
    const request = new URL(String(input), window.location.origin);
    const target = new URL(
      request.searchParams.get("path") ?? request.href,
      window.location.origin
    );
    const [, , documentId, tab] = target.pathname.split("/");
    return Promise.resolve(
      new Response(
        `${JSON.stringify(toCrossJSON({ params: { documentId, tab }, query: { view: target.searchParams.get("view") } }))}\n`,
        { headers: { "Content-Type": "application/x-ndjson" } }
      )
    );
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
        initialData={initialData}
        initialDigest={undefined}
        initialMatch={match}
        initialNotFound={undefined}
        prefetchCacheSize={50}
        root={null}
        routes={[match]}
      />
    )
  );
  if (!router) {
    throw new Error("Router did not mount");
  }
  return {
    container,
    router,
    async cleanup() {
      await act(() => root.unmount());
      container.remove();
      globalThis.fetch = originalFetch;
    },
  };
}

test("path parameter navigation resets the page but preserves its shared layout", async () => {
  const app = await mountRouter(undefined);
  try {
    await act(() => {
      app.container.querySelector<HTMLButtonElement>("section > button")?.click();
      app.container.querySelector<HTMLButtonElement>("main button")?.click();
    });
    expect(app.container.textContent).toContain("Layout 1");
    expect(app.container.textContent).toContain("Page 1");
    await act(() => app.router.navigate("/remount-doc/two/edit?view=grid"));
    expect(app.container.querySelector("output")?.textContent).toBe("two:edit:grid");
    expect(app.container.textContent).toContain("Layout 1");
    expect(app.container.textContent).toContain("Page 0");
  } finally {
    await app.cleanup();
  }
});

test("custom dependencies preserve tab changes but reset on another document", async () => {
  const app = await mountRouter(({ params }) => [params.documentId]);
  try {
    await act(() => app.container.querySelector<HTMLButtonElement>("main button")?.click());
    await act(() => app.router.navigate("/remount-doc/one/preview?view=list"));
    expect(app.container.querySelector("output")?.textContent).toBe("one:preview:list");
    expect(app.container.textContent).toContain("Page 1");
    await act(() => app.router.navigate("/remount-doc/two/preview?view=list"));
    expect(app.container.querySelector("output")?.textContent).toBe("two:preview:list");
    expect(app.container.textContent).toContain("Page 0");
  } finally {
    await app.cleanup();
  }
});

test.each(["refresh", "search", "hash"])("%s preserves the active page state", async (change) => {
  const app = await mountRouter(undefined);
  try {
    await act(() => app.container.querySelector<HTMLButtonElement>("main button")?.click());
    await act(() => {
      if (change === "refresh") {
        return app.router.refresh();
      }
      return app.router.navigate(
        change === "search"
          ? "/remount-doc/one/edit?view=list"
          : "/remount-doc/one/edit?view=grid#section"
      );
    });
    expect(app.container.textContent).toContain("Page 1");
    if (change === "search") {
      expect(app.container.querySelector("output")?.textContent).toBe("one:edit:list");
    }
  } finally {
    await app.cleanup();
  }
});

test("empty dependencies preserve the page across parameter changes", async () => {
  const app = await mountRouter(() => []);
  try {
    await act(() => app.container.querySelector<HTMLButtonElement>("main button")?.click());
    await act(() => app.router.navigate("/remount-doc/two/preview?view=list"));
    expect(app.container.querySelector("output")?.textContent).toBe("two:preview:list");
    expect(app.container.textContent).toContain("Page 1");
  } finally {
    await app.cleanup();
  }
});

test("query values can explicitly participate in custom page identity", async () => {
  const app = await mountRouter(({ params, query }) => [params.documentId, query.view]);
  try {
    await act(() => app.container.querySelector<HTMLButtonElement>("main button")?.click());
    await act(() => app.router.navigate("/remount-doc/one/edit?view=list"));
    expect(app.container.querySelector("output")?.textContent).toBe("one:edit:list");
    expect(app.container.textContent).toContain("Page 0");
  } finally {
    await app.cleanup();
  }
});

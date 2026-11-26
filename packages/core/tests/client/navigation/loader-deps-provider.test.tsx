import { expect, test } from "bun:test";
import { t } from "elysia";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { toCrossJSON } from "seroval";
import { RouterProvider, useRouter } from "../../../src/client/link.tsx";
import { useSearch } from "../../../src/client/router/search/index.ts";
import type { LoadedClientRoute } from "../../../src/client/router/types.ts";
import { defineRootRoute, defineRoute } from "../../../src/define-route.ts";
import { adaptDefinedLayout, adaptDefinedPage } from "../../../src/server/router/defined-route.ts";
import { useDomTests } from "../../support/dom.ts";
import { navigationDataPath } from "../../support/navigation-data.ts";

useDomTests();

const PRODUCTS_PATTERN = /^\/products$/;

type SetSearch = (
  next: { edit?: string; category?: string },
  opts?: { replace?: boolean; shallow?: boolean }
) => Promise<void>;

async function mountProducts(withLoaderDeps: boolean) {
  let setSearch: SetSearch | undefined;
  const pendingStates: boolean[] = [];
  const fetched: string[] = [];
  const layout = defineRootRoute()
    .config({ mode: "ssr" })
    .layout(({ children }) => <section>{children}</section>);
  const products = defineRoute("/products")
    .config({
      mode: "ssr",
      query: t.Object({ category: t.String(), edit: t.Optional(t.String()) }),
      ...(withLoaderDeps
        ? { loaderDeps: ({ edit: _, ...deps }: { category: string; edit?: string }) => deps }
        : {}),
    })
    .page(({ query }) => {
      const router = useRouter();
      pendingStates.push(router.isNavigating);
      [, setSearch] = useSearch("/products" as string) as unknown as [unknown, SetSearch];
      return <output>{`${query.category}:${query.edit ?? "closed"}`}</output>;
    });
  const page = adaptDefinedPage(products, adaptDefinedLayout(layout, undefined));
  const match: LoadedClientRoute = {
    component: page.component,
    load: () => Promise.resolve({ default: page }),
    pageRoute: page._route,
    pattern: "/products",
    regex: PRODUCTS_PATTERN,
  };
  window.history.replaceState(null, "", "/products?category=tea");
  const originalFetch = globalThis.fetch;
  globalThis.fetch = ((input: RequestInfo | URL) => {
    const target = new URL(
      navigationDataPath(input, window.location.origin) ?? String(input),
      window.location.origin
    );
    fetched.push(target.pathname + target.search);
    return Promise.resolve(
      new Response(
        `${JSON.stringify(toCrossJSON({ query: Object.fromEntries(target.searchParams) }))}\n`,
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
        initialData={{ query: { category: "tea" } }}
        initialDigest={undefined}
        initialMatch={match}
        prefetchCacheSize={50}
        root={null}
        routes={[match]}
      />
    )
  );
  return {
    fetched,
    output: () => container.querySelector("output")?.textContent,
    pendingStates,
    setSearch: (...args: Parameters<SetSearch>) => {
      if (!setSearch) {
        throw new Error("Page did not mount");
      }
      return setSearch(...args);
    },
    async cleanup() {
      await act(() => root.unmount());
      container.remove();
      globalThis.fetch = originalFetch;
    },
  };
}

test("useSearch opens a panel in place when loaderDeps exclude its param", async () => {
  const app = await mountProducts(true);
  try {
    await act(() => app.setSearch({ edit: "7" }, { replace: true }));
    expect(app.output()).toBe("tea:7");
    expect(window.location.search).toBe("?category=tea&edit=7");
    await act(() => app.setSearch({ edit: undefined }));
    expect(app.output()).toBe("tea:closed");
    expect(app.fetched).toEqual([]);
    expect(app.pendingStates).not.toContain(true);
    await act(() => app.setSearch({ category: "coffee" }));
    expect(app.fetched).toEqual(["/products?category=coffee"]);
    expect(app.output()).toBe("coffee:closed");
  } finally {
    await app.cleanup();
  }
});

test("useSearch with shallow commits in place on a route without loaderDeps", async () => {
  const app = await mountProducts(false);
  try {
    await act(() => app.setSearch({ edit: "7" }, { shallow: true }));
    expect(app.output()).toBe("tea:7");
    expect(app.fetched).toEqual([]);
    expect(app.pendingStates).not.toContain(true);
    await act(() => app.setSearch({ edit: "8" }));
    expect(app.fetched).toEqual(["/products?category=tea&edit=8"]);
  } finally {
    await app.cleanup();
  }
});

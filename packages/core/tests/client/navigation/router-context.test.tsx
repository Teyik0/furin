import "../../setup/global.ts";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { act, memo } from "react";
import { createRoot, type Root } from "react-dom/client";
import { toCrossJSON } from "seroval";
import { Link, RouterProvider, useNavigate, useRouter } from "../../../src/client/link.tsx";
import type { ClientRoute } from "../../../src/client/router/index.ts";
import { installDom, resetDomState, uninstallDom } from "../../support/dom.ts";

const HOME_RE = /^\/$/;
let root: Root | undefined;

beforeEach(() => {
  installDom();
  resetDomState();
});

afterEach(async () => {
  await act(() => root?.unmount());
  root = undefined;
  document.body.replaceChildren();
  await uninstallDom();
});

test("a provider re-render that changes no router value does not re-render router consumers", async () => {
  let probeRenders = 0;
  const Probe = memo(() => {
    useRouter();
    probeRenders += 1;
    return null;
  });
  function Page({ slow }: { slow?: Promise<string> }) {
    return (
      <main>
        <Probe />
        {slow ? "page" : ""}
      </main>
    );
  }
  const deferred = Promise.withResolvers<string>();
  const home: ClientRoute = {
    load: async () => ({ default: { _route: {} as never, component: Page } }),
    pattern: "/",
    regex: HOME_RE,
  };
  const container = document.createElement("div");
  document.body.appendChild(container);
  const viewRoot = createRoot(container);
  root = viewRoot;
  await act(() => {
    viewRoot.render(
      <RouterProvider
        autoRefresh={false}
        basePath=""
        defaultPreload={false}
        defaultPreloadDelay={0}
        defaultPreloadStaleTime={30_000}
        initialData={{ slow: deferred.promise }}
        initialDigest={undefined}
        initialMatch={{ ...home, component: Page, pageRoute: {} as never }}
        initialNotFound={undefined}
        prefetchCacheSize={50}
        root={null}
        routes={[home]}
      />
    );
  });
  expect(container.textContent).toBe("page");
  const rendersBefore = probeRenders;
  // Resolving loader data re-renders the provider without changing router state.
  await act(async () => {
    deferred.resolve("done");
    await deferred.promise;
  });
  expect(probeRenders).toBe(rendersBefore);
});

test("Links and useNavigate re-render only when their own selection changes", async () => {
  let unrelatedLinkRenders = 0;
  let router: ReturnType<typeof useRouter> | undefined;
  let navigateRenders = 0;
  const NavigateProbe = memo(() => {
    useNavigate();
    navigateRenders += 1;
    return null;
  });
  const Nav = memo(() => (
    <nav>
      <NavigateProbe />
      <Link to={"/elsewhere" as string}>
        {() => {
          unrelatedLinkRenders += 1;
          return "elsewhere";
        }}
      </Link>
      <Link to={"/?tab=2" as string}>tab</Link>
    </nav>
  ));
  function Page() {
    router = useRouter();
    return <Nav />;
  }
  const home: ClientRoute = {
    load: async () => ({ default: { _route: {} as never, component: Page } }),
    pattern: "/",
    regex: HOME_RE,
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (() =>
    Promise.resolve(
      new Response(`${JSON.stringify(toCrossJSON({}))}\n`, {
        headers: { "Content-Type": "application/x-ndjson" },
      })
    )) as unknown as typeof fetch;
  const container = document.createElement("div");
  document.body.appendChild(container);
  const viewRoot = createRoot(container);
  root = viewRoot;
  try {
    await act(() => {
      viewRoot.render(
        <RouterProvider
          autoRefresh={false}
          basePath=""
          defaultPreload={false}
          defaultPreloadDelay={0}
          defaultPreloadStaleTime={30_000}
          initialData={{}}
          initialDigest={undefined}
          initialMatch={{ ...home, component: Page, pageRoute: {} as never }}
          initialNotFound={undefined}
          prefetchCacheSize={50}
          root={null}
          routes={[home]}
        />
      );
    });
    const rendersBefore = unrelatedLinkRenders;
    const navigateRendersBefore = navigateRenders;
    const tabLink = container.querySelector<HTMLAnchorElement>('a[href="/?tab=2"]');
    expect(tabLink?.dataset.status).toBeUndefined();
    // Navigating flips isNavigating and changes currentHref and search.
    await act(() => router?.navigate("/?tab=2" as string));
    expect(tabLink?.dataset.status).toBe("active");
    expect(unrelatedLinkRenders).toBe(rendersBefore);
    expect(navigateRenders).toBe(navigateRendersBefore);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

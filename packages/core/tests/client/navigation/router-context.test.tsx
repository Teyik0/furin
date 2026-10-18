import "../../setup/global.ts";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { act, memo } from "react";
import { createRoot, type Root } from "react-dom/client";
import { RouterProvider, useRouter } from "../../../src/client/link.tsx";
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

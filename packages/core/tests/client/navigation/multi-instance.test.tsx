import "../../setup/global.ts";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { toCrossJSON } from "seroval";
import { RouterProvider, useRouter } from "../../../src/client/link.tsx";
import type { ClientRoute } from "../../../src/client/router/index.ts";
import { installDom, resetDomState, uninstallDom } from "../../support/dom.ts";

type HmrRefresh = (beforeCommit: (() => void) | undefined, dataChanged: boolean) => Promise<void>;
interface HmrWindow {
  __FURIN_HMR_REFRESH__?: HmrRefresh;
}

const roots: Root[] = [];
let originalFetch: typeof fetch;
let dataReads = 0;

beforeEach(() => {
  installDom();
  resetDomState();
  originalFetch = window.fetch;
  dataReads = 0;
  const base = (input: RequestInfo | URL) => {
    const url = new URL(String(input), window.location.origin);
    if (url.searchParams.get("_furin") === "data") {
      dataReads += 1;
      return Promise.resolve(
        new Response(`${JSON.stringify(toCrossJSON({ message: `read ${dataReads}` }))}\n`, {
          headers: { "Content-Type": "application/x-ndjson" },
        })
      );
    }
    const response = new Response("ok", {
      headers: { "x-furin-revalidate": "/target" },
    });
    Object.defineProperty(response, "url", { value: url.href });
    return Promise.resolve(response);
  };
  window.fetch = Object.assign(base, originalFetch);
  globalThis.fetch = window.fetch;
});

afterEach(async () => {
  for (const root of roots.splice(0)) {
    // biome-ignore lint/performance/noAwaitInLoops: roots unmount one at a time.
    await act(() => root.unmount());
  }
  document.body.replaceChildren();
  window.fetch = originalFetch;
  globalThis.fetch = originalFetch;
  await uninstallDom();
});

const HOME_RE = /^\/$/;
const TARGET_RE = /^\/target$/;

async function mountRouter(): Promise<{ router: () => ReturnType<typeof useRouter>; root: Root }> {
  let current: ReturnType<typeof useRouter> | undefined;
  function Page({ message }: { message?: unknown }) {
    current = useRouter();
    return <main>{String(message ?? "home")}</main>;
  }
  const routes: [ClientRoute, ...ClientRoute[]] = [
    {
      load: async () => ({ default: { _route: {} as never, component: Page } }),
      pattern: "/",
      regex: HOME_RE,
    },
    {
      load: async () => ({ default: { _route: {} as never, component: Page } }),
      pattern: "/target",
      regex: TARGET_RE,
    },
  ];
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  roots.push(root);
  await act(() => {
    root.render(
      <RouterProvider
        autoRefresh={false}
        basePath=""
        defaultPreload={false}
        defaultPreloadDelay={0}
        defaultPreloadStaleTime={30_000}
        initialData={{}}
        initialDigest={undefined}
        initialMatch={{ ...routes[0], component: Page, pageRoute: {} as never }}
        prefetchCacheSize={50}
        root={null}
        routes={routes}
      />
    );
  });
  return {
    root,
    router: () => {
      if (!current) {
        throw new Error("router not mounted");
      }
      return current;
    },
  };
}

async function unmount(root: Root): Promise<void> {
  await act(() => root.unmount());
  roots.splice(roots.indexOf(root), 1);
}

test("unmounting one router keeps fetch revalidation working for the others", async () => {
  const first = await mountRouter();
  const second = await mountRouter();
  await act(async () => {
    second.router().prefetch("/target" as string);
    await Bun.sleep(0);
  });
  expect(dataReads).toBe(1);
  await unmount(first.root);
  await window.fetch("/api/mutate");
  await act(() => second.router().navigate("/target" as string));
  expect(dataReads).toBe(2);
});

test("unmounting every router restores the original fetch", async () => {
  const patched = window.fetch;
  const first = await mountRouter();
  const second = await mountRouter();
  expect(window.fetch).not.toBe(patched);
  await unmount(first.root);
  await unmount(second.root);
  expect(window.fetch).toBe(patched);
});

test("an HMR refresh reaches every mounted router and survives one unmounting", async () => {
  const first = await mountRouter();
  const second = await mountRouter();
  const hmrWindow = window as unknown as HmrWindow;
  let commits = 0;
  await act(async () => {
    await hmrWindow.__FURIN_HMR_REFRESH__?.(() => {
      commits += 1;
    }, true);
  });
  expect(dataReads).toBe(2);
  expect(commits).toBe(1);
  await unmount(second.root);
  await act(async () => {
    await hmrWindow.__FURIN_HMR_REFRESH__?.(undefined, true);
  });
  expect(dataReads).toBe(3);
  await unmount(first.root);
  expect(hmrWindow.__FURIN_HMR_REFRESH__).toBeUndefined();
});

import "../../setup/global.ts";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { NavigationController } from "../../../src/client/router/navigation-controller.ts";
import { createOptimisticRuntime } from "../../../src/client/router/optimistic.ts";
import type { PageResult } from "../../../src/client/router/page-fetch.ts";
import type { LoadedClientRoute, RouterState } from "../../../src/client/router/types.ts";
import type { SearchParamsInput } from "../../../src/shared/search-params.ts";
import { installDom, resetDomState, uninstallDom } from "../../support/dom.ts";

beforeEach(() => {
  installDom();
  resetDomState();
});

afterEach(async () => {
  await uninstallDom();
});

type LoaderDeps = (query: SearchParamsInput) => object;

function routeFor(pattern: string, loaderDeps: LoaderDeps | undefined): LoadedClientRoute {
  const route = {
    component: () => null,
    pageRoute: { __type: "FURIN_ROUTE" as const, loaderDeps },
    pattern,
    regex: new RegExp(`^${pattern}$`),
  };
  return { ...route, load: () => Promise.reject(new Error("unused")) };
}

const withoutEdit: LoaderDeps = ({ edit: _, ...deps }) => deps;

/**
 * Pages are served from `/products` (with `loaderDeps` dropping `edit`) and
 * `/orders`; each response echoes the search it was loaded for.
 */
function createController(loaderDeps: LoaderDeps | undefined) {
  const fetched: string[] = [];
  const products = routeFor("/products", loaderDeps);
  const orders = routeFor("/orders", undefined);
  const stateFor = (href: string): RouterState => {
    const url = new URL(href, "http://furin.local");
    return {
      data: { loadedFor: href, query: Object.fromEntries(url.searchParams) },
      match: url.pathname === "/products" ? products : orders,
    };
  };
  const statuses: boolean[] = [];
  window.history.replaceState(null, "", "/products?category=a");
  const controller = new NavigationController({
    config: {
      basePath: "",
      defaultStaleTime: 30_000,
      fetchPage: ({ href }) => {
        fetched.push(href);
        const result: PageResult = { kind: "page", reusable: () => true, state: stateFor(href) };
        return Promise.resolve(result);
      },
      maxCacheSize: 50,
      resolvePending: () => Promise.resolve(undefined),
    },
    initial: {
      href: "/products?category=a",
      isNavigating: false,
      resetVersion: 0,
      state: stateFor("/products?category=a"),
    },
    optimistic: createOptimisticRuntime({
      basePath: "",
      onResponse: () => undefined,
      snapshot: () => ({ href: "/products", loaded: true, pattern: "/products" }),
    }),
  });
  controller.adoptHistoryEntry();
  controller.subscribe(() => statuses.push(controller.getSnapshot().isNavigating));
  return { controller, fetched, statuses };
}

async function back(controller: NavigationController): Promise<void> {
  const popped = Promise.withResolvers<void>();
  window.addEventListener("popstate", () => popped.resolve(), { once: true });
  history.back();
  await popped.promise;
  controller.popState();
  await Bun.sleep(0);
}

test("a search change outside loaderDeps commits in place without fetching", async () => {
  const { controller, fetched, statuses } = createController(withoutEdit);
  const entries = history.length;
  await controller.navigate("/products?category=a&edit=7", {
    search: { category: "a", edit: "7" },
  });
  expect(fetched).toEqual([]);
  expect(statuses).toEqual([false]);
  expect(history.length).toBe(entries + 1);
  expect(window.location.search).toBe("?category=a&edit=7");
  expect(controller.getSnapshot()).toMatchObject({
    href: "/products?category=a&edit=7",
    isNavigating: false,
    state: { data: { loadedFor: "/products?category=a", query: { category: "a", edit: "7" } } },
  });
});

test("a search change inside loaderDeps still fetches the page", async () => {
  const { controller, fetched, statuses } = createController(withoutEdit);
  await controller.navigate("/products?category=b", { search: { category: "b" } });
  expect(fetched).toEqual(["/products?category=b"]);
  expect(statuses).toEqual([true, false]);
  expect(controller.getSnapshot().state.data.loadedFor).toBe("/products?category=b");
});

test("routes without loaderDeps and navigations without a typed search keep fetching", async () => {
  const plain = createController(undefined);
  await plain.controller.navigate("/products?category=a&edit=7", {
    search: { category: "a", edit: "7" },
  });
  expect(plain.fetched).toEqual(["/products?category=a&edit=7"]);
  await uninstallDom();
  installDom();
  resetDomState();
  const untyped = createController(withoutEdit);
  await untyped.controller.navigate("/products?category=a&edit=7");
  expect(untyped.fetched).toEqual(["/products?category=a&edit=7"]);
});

test("replace swaps the history entry in place", async () => {
  const { controller, fetched } = createController(withoutEdit);
  const entries = history.length;
  await controller.navigate("/products?category=a&edit=7", {
    replace: true,
    search: { category: "a", edit: "7" },
  });
  expect(fetched).toEqual([]);
  expect(history.length).toBe(entries);
  expect(window.location.search).toBe("?category=a&edit=7");
});

test("back and forward between searches sharing loader deps reuse the page", async () => {
  const { controller, fetched, statuses } = createController(withoutEdit);
  await controller.navigate("/products?category=a&edit=7", {
    search: { category: "a", edit: "7" },
  });
  await back(controller);
  expect(window.location.search).toBe("?category=a");
  expect(controller.getSnapshot()).toMatchObject({
    href: "/products?category=a",
    state: { data: { query: { category: "a" } } },
  });
  const forwarded = Promise.withResolvers<void>();
  window.addEventListener("popstate", () => forwarded.resolve(), { once: true });
  history.forward();
  await forwarded.promise;
  controller.popState();
  await Bun.sleep(0);
  expect(controller.getSnapshot().state.data.query).toEqual({ category: "a", edit: "7" });
  expect(fetched).toEqual([]);
  expect(statuses.every((navigating) => !navigating)).toBe(true);
});

test("returning from another route reuses a cached page with the same loader deps", async () => {
  const { controller, fetched } = createController(withoutEdit);
  await controller.navigate("/products?category=b", { search: { category: "b" } });
  await controller.navigate("/products?category=b&edit=7", {
    search: { category: "b", edit: "7" },
  });
  await controller.navigate("/orders");
  await back(controller);
  expect(fetched).toEqual(["/products?category=b", "/orders"]);
  expect(controller.getSnapshot()).toMatchObject({
    href: "/products?category=b&edit=7",
    state: { data: { loadedFor: "/products?category=b", query: { category: "b", edit: "7" } } },
  });
});

test("prefetching a search that shares loader deps reuses the loaded page", async () => {
  const { controller, fetched } = createController(withoutEdit);
  controller.prefetch("/products?category=a&edit=7", undefined, { category: "a", edit: "7" });
  controller.prefetch("/products?category=b", undefined, { category: "b" });
  await Bun.sleep(0);
  expect(fetched).toEqual(["/products?category=b"]);
});

test("shallow navigation commits a same-path search in place, even for loader deps", async () => {
  const { controller, fetched, statuses } = createController(undefined);
  await controller.navigate("/products?category=b", { search: { category: "b" }, shallow: true });
  expect(fetched).toEqual([]);
  expect(statuses).toEqual([false]);
  expect(controller.getSnapshot()).toMatchObject({
    href: "/products?category=b",
    state: { data: { loadedFor: "/products?category=a", query: { category: "b" } } },
  });
  await back(controller);
  expect(fetched).toEqual(["/products?category=a"]);
});

test("shallow navigation to another path falls back to a normal navigation", async () => {
  const { controller, fetched, statuses } = createController(undefined);
  await controller.navigate("/orders?page=2", { search: { page: "2" }, shallow: true });
  expect(fetched).toEqual(["/orders?page=2"]);
  expect(statuses).toEqual([true, false]);
  expect(controller.getSnapshot().state.data.loadedFor).toBe("/orders?page=2");
});

test("an in-place commit supersedes a pending navigation", async () => {
  const { controller } = createController(withoutEdit);
  const pending = controller.navigate("/orders");
  await controller.navigate("/products?category=a&edit=7", {
    search: { category: "a", edit: "7" },
  });
  await pending;
  expect(controller.getSnapshot()).toMatchObject({
    href: "/products?category=a&edit=7",
    isNavigating: false,
  });
  expect(window.location.pathname).toBe("/products");
});

test("an in-place commit removes the pending screen of the navigation it supersedes", async () => {
  const { controller } = createController(withoutEdit);
  controller.configure({
    basePath: "",
    defaultStaleTime: 30_000,
    fetchPage: () => new Promise<PageResult>(() => undefined),
    maxCacheSize: 50,
    resolvePending: () => Promise.resolve({ component: () => null, depth: 0, minMs: 0, ms: 0 }),
  });
  const shown = Promise.withResolvers<void>();
  const unsubscribe = controller.subscribe(() => {
    if (controller.getSnapshot().pending) {
      shown.resolve();
    }
  });
  controller.navigate("/orders");
  await shown.promise;
  unsubscribe();
  await controller.navigate("/products?category=a&edit=7", {
    search: { category: "a", edit: "7" },
  });
  expect(controller.getSnapshot()).toMatchObject({ isNavigating: false, pending: undefined });
  expect(controller.getSnapshot().state.data.query).toEqual({ category: "a", edit: "7" });
});

test("an in-place candidate honours shouldCommit", async () => {
  const { controller, fetched } = createController(withoutEdit);
  await controller.navigate("/products?category=a&edit=7", {
    search: { category: "a", edit: "7" },
    shouldCommit: () => false,
  });
  expect(controller.getSnapshot().href).toBe("/products?category=a");
  expect(window.location.search).toBe("?category=a");
  expect(fetched).toEqual(["/products?category=a&edit=7"]);
});

test("a redirected pop records the canonical search on its history entry", async () => {
  const { controller } = createController(withoutEdit);
  controller.configure({
    basePath: "",
    defaultStaleTime: 30_000,
    fetchPage: ({ href }) =>
      Promise.resolve<PageResult>(
        href === "/orders?page=old"
          ? { href: "/orders?page=1", kind: "redirect" }
          : {
              kind: "page",
              reusable: () => true,
              state: { data: { query: { page: "1" } }, match: routeFor("/orders", undefined) },
            }
      ),
    maxCacheSize: 50,
    resolvePending: () => Promise.resolve(undefined),
  });
  history.pushState({ _furinKey: "stale", _furinSearch: { page: "old" } }, "", "/orders?page=old");
  controller.popState();
  await Bun.sleep(0);
  expect(window.location.search).toBe("?page=1");
  expect(history.state).toMatchObject({ _furinKey: "stale", _furinSearch: { page: "1" } });
});

import "../../setup/global.ts";
import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  NavigationController,
  type NavigationControllerConfig,
} from "../../../src/client/router/navigation-controller.ts";
import { createOptimisticRuntime } from "../../../src/client/router/optimistic.ts";
import type { PageResult } from "../../../src/client/router/page-fetch.ts";
import { installDom, resetDomState, uninstallDom } from "../../support/dom.ts";

beforeEach(() => {
  installDom();
  resetDomState();
});

afterEach(async () => {
  await uninstallDom();
});

function createController(maxCacheSize: number) {
  const fetched: string[] = [];
  const fetchPage: NavigationControllerConfig["fetchPage"] = ({ href }) => {
    fetched.push(href);
    const result: PageResult = {
      kind: "page",
      reusable: () => true,
      state: { data: { href }, match: null },
    };
    return Promise.resolve(result);
  };
  const controller = new NavigationController({
    config: { basePath: "", defaultStaleTime: 30_000, fetchPage, maxCacheSize },
    initial: { href: "/", isNavigating: false, resetVersion: 0, state: { data: {}, match: null } },
    optimistic: createOptimisticRuntime({
      basePath: "",
      onResponse: () => undefined,
      snapshot: () => ({ href: "/", loaded: true, pattern: "/" }),
    }),
  });
  return { controller, fetched };
}

test("evicts the oldest prefetch once the cache exceeds its size", async () => {
  const { controller, fetched } = createController(2);
  controller.prefetch("/a", undefined);
  controller.prefetch("/b", undefined);
  controller.prefetch("/c", undefined);
  await controller.navigate("/c");
  expect(fetched).toEqual(["/a", "/b", "/c"]);
  await controller.navigate("/a");
  expect(fetched).toEqual(["/a", "/b", "/c", "/a"]);
  expect(controller.getSnapshot().href).toBe("/a");
  expect(window.location.pathname).toBe("/a");
});

test("push and pop publish the same snapshot shape and track navigation status", async () => {
  const { controller, fetched } = createController(50);
  const statuses: boolean[] = [];
  controller.subscribe(() => statuses.push(controller.getSnapshot().isNavigating));
  await controller.navigate("/a");
  expect(controller.getSnapshot()).toMatchObject({
    href: "/a",
    isNavigating: false,
    resetVersion: 1,
    state: { data: { href: "/a" } },
  });
  history.pushState({ _furinKey: "popped" }, "", "/b?x=1");
  controller.popState();
  await Bun.sleep(0);
  expect(fetched).toEqual(["/a", "/b?x=1"]);
  expect(controller.getSnapshot()).toMatchObject({
    href: "/b?x=1",
    isNavigating: false,
    resetVersion: 2,
    state: { data: { href: "/b?x=1" } },
  });
  expect(controller.takeScrollInstruction()).toEqual({ key: "popped", type: "restore" });
  expect(statuses).toEqual([true, false, true, false]);
});

test("context invalidation fences ignored cancellation and aborts pending and committed transports", async () => {
  const { controller } = createController(50);
  const started = Promise.withResolvers<void>();
  const oldResult = Promise.withResolvers<PageResult>();
  const signals = new Map<string, AbortSignal | undefined>();
  controller.configure({
    basePath: "",
    defaultStaleTime: 30_000,
    maxCacheSize: 50,
    fetchPage: ({ href, signal }) => {
      signals.set(href, signal);
      if (href === "/private") {
        started.resolve();
        return oldResult.promise;
      }
      return Promise.resolve({
        kind: "page",
        reusable: () => true,
        state: { data: { message: "public" }, match: null },
      });
    },
  });
  await controller.navigate("/public");
  const navigation = controller.navigate("/private");
  await started.promise;
  const waitingForNavigation = controller.waitForUserNavigation();
  controller.invalidateContext();
  await waitingForNavigation;
  await navigation;
  expect(signals.get("/public")?.aborted).toBe(true);
  expect(signals.get("/private")?.aborted).toBe(true);
  expect(controller.getSnapshot().isNavigating).toBe(false);
  oldResult.resolve({
    kind: "page",
    reusable: () => true,
    state: { data: { message: "PRIVATE_BEFORE_REVOCATION" }, match: null },
  });
  await Bun.sleep(0);
  expect(controller.getSnapshot().href).toBe("/public");
  expect(controller.getSnapshot().state.data).toEqual({ message: "public" });
});

test("context refresh follows the current navigation instead of an obsolete request", async () => {
  const { controller } = createController(50);
  const firstResponse = Promise.withResolvers<PageResult>();
  const secondResponse = Promise.withResolvers<PageResult>();
  const firstStarted = Promise.withResolvers<void>();
  const secondStarted = Promise.withResolvers<void>();
  const requested: string[] = [];
  controller.configure({
    basePath: "",
    defaultStaleTime: 30_000,
    maxCacheSize: 50,
    fetchPage: ({ href }) => {
      requested.push(href);
      if (href === "/a") {
        firstStarted.resolve();
        return firstResponse.promise;
      }
      if (href === "/b") {
        secondStarted.resolve();
        return secondResponse.promise;
      }
      return Promise.resolve({
        kind: "page",
        reusable: () => true,
        state: { data: { message: "new-context" }, match: null },
      });
    },
  });
  const first = controller.navigate("/a");
  await firstStarted.promise;
  const refresh = controller.waitForUserNavigation().then(() => controller.refresh());
  const second = controller.navigate("/b");
  await secondStarted.promise;
  controller.invalidateContext();
  try {
    await Bun.sleep(0);
    expect(requested).toEqual(["/a", "/b", "/"]);
    expect(controller.getSnapshot().state.data).toEqual({ message: "new-context" });
  } finally {
    firstResponse.resolve({ kind: "aborted" });
    secondResponse.resolve({ kind: "aborted" });
    await Promise.all([first, second, refresh]);
  }
});

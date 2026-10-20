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

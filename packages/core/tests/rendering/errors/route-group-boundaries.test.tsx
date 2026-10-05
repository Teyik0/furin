import { afterAll, beforeAll, expect, test } from "bun:test";
import { join } from "node:path";
import { act } from "react";
import { hydrateRoot, type Root } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { buildPageElement } from "../../../src/client/router/boundary-tree.tsx";
import type { LoadedClientRoute } from "../../../src/client/router/types.ts";
import { buildElement } from "../../../src/server/render/element.tsx";
import { scanPages } from "../../../src/server/router/discovery.ts";
import { buildRouteRegex } from "../../../src/server/router/patterns.ts";
import { __setDevMode, IS_DEV } from "../../../src/server/runtime-env.ts";
import { useDomTests } from "../../support/dom.ts";
import { expectDefined } from "../../support/utils.ts";

const PAGES_DIR = join(import.meta.dir, "../../fixtures/pages/group-boundaries");
let originalDevMode: boolean;
const scenarios = [
  { pattern: "/page", failure: "page failed", fallback: "inner", message: "page failed" },
  { pattern: "/page", failure: "bubble", fallback: "outer", message: "bubble" },
  { pattern: "/page", failure: "not-found", fallback: "outer-not-found", message: "missing page" },
  { pattern: "/detail", failure: "layout failed", fallback: "inner", message: "layout failed" },
];

useDomTests();
beforeAll(() => {
  originalDevMode = IS_DEV;
  __setDevMode(false);
});
afterAll(() => __setDevMode(originalDevMode));

test.each(scenarios.flatMap((scenario) => [false, true].map((dev) => ({ ...scenario, dev }))))(
  "nested groups handle $failure after hydration (dev=$dev)",
  async ({ dev, pattern, failure, fallback, message }) => {
    __setDevMode(dev);
    const { root: layout, routes } = await scanPages(PAGES_DIR);
    const route = routes.find((candidate) => candidate.pattern === pattern);
    expectDefined(route);
    const match: LoadedClientRoute = {
      component: route.page.component,
      load: () => Promise.resolve({ default: route.page }),
      pageRoute: route.page._route,
      pattern: route.pattern,
      regex: buildRouteRegex(pattern).regex,
      segmentBoundaries: route.segmentBoundaries,
    };
    const container = document.createElement("div");
    const data = { query: { failure } };
    container.innerHTML = renderToString(buildElement(route, data, layout.route));
    document.body.appendChild(container);
    const errors: unknown[] = [];
    let root: Root | undefined;
    try {
      await act(() => {
        root = hydrateRoot(
          container,
          buildPageElement(match, layout.route, data, undefined, undefined),
          { onRecoverableError: (error) => errors.push(error) }
        );
      });
      expect(errors).toEqual([]);
      await act(() => container.querySelector<HTMLButtonElement>("button")?.click());
      expect(container.querySelector(`[data-fallback="${fallback}"]`)?.textContent).toBe(message);
      expect(container.querySelector('[data-layout="root"]')).not.toBeNull();
    } finally {
      await act(() => root?.unmount());
      container.remove();
    }
  }
);

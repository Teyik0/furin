import "../../../packages/core/tests/setup/global.ts";
import { expect, test } from "bun:test";
import { RouterContext, SSR_FALLBACK_ROUTER } from "@teyik0/furin/link";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import {
  installDom,
  useDomTests as setupDomTests,
  waitForDom,
} from "../../../packages/core/tests/support/dom.ts";
import { DocsSearch } from "../src/components/docs-search-trigger";

installDom();
setupDomTests();

test.each([
  {
    path: "/docs/getting-started",
    basePath: "",
    label: "Search the docs",
    indexPath: "/search-entries.json",
  },
  {
    path: "/docs/desktop",
    basePath: "/furin",
    label: "Search desktop docs",
    indexPath: "/furin/docs/desktop/search-entries.json",
  },
])(
  "search for $path is lazy and works by button and keyboard",
  async ({ path, basePath, label, indexPath }) => {
    const originalFetch = globalThis.fetch;
    const requests: string[] = [];
    globalThis.fetch = ((input: RequestInfo | URL) => {
      const url = input instanceof Request ? input.url : String(input);
      requests.push(url);
      if (url !== indexPath) {
        return Promise.reject(new Error(`Unexpected search request: ${url}`));
      }
      return Promise.resolve(Response.json([]));
    }) as typeof fetch;
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    try {
      await act(() =>
        root.render(
          createElement(
            RouterContext.Provider,
            { value: { ...SSR_FALLBACK_ROUTER, basePath, currentHref: path } },
            createElement(DocsSearch)
          )
        )
      );
      expect(container.textContent).toContain(label);
      expect(requests).toEqual([]);
      await act(async () => {
        window.dispatchEvent(new KeyboardEvent("keydown", { ctrlKey: true, key: "k" }));
        await import("../src/components/docs-search-dialog");
      });
      await waitForDom(() => document.querySelector('[role="dialog"]') !== null, {
        timeoutMs: 2000,
      });
      expect(document.querySelector(`input[placeholder="${label}…"]`)).not.toBeNull();
      await waitForDom(() => requests.length === 1, { timeoutMs: 2000 });
      expect(requests).toEqual([indexPath]);
      await act(() =>
        window.dispatchEvent(new KeyboardEvent("keydown", { ctrlKey: true, key: "k" }))
      );
      expect(document.querySelector('[role="dialog"]')).toBeNull();
      await act(() => container.querySelector("button")?.click());
      expect(document.querySelector('[role="dialog"]')).not.toBeNull();
      expect(requests).toEqual([indexPath]);
    } finally {
      await act(() => root.unmount());
      container.remove();
      globalThis.fetch = originalFetch;
    }
  }
);

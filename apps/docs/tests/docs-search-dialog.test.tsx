import "../../../packages/core/tests/setup/global.ts";
import { expect, test } from "bun:test";
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

test("search is available by button and keyboard without loading its index before opening", async () => {
  const originalFetch = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = (() => {
    requests += 1;
    return Promise.resolve(Response.json([]));
  }) as typeof fetch;
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    await act(() => root.render(createElement(DocsSearch)));
    expect(container.textContent).toContain("Search the docs");
    expect(requests).toBe(0);
    await act(() =>
      window.dispatchEvent(new KeyboardEvent("keydown", { ctrlKey: true, key: "k" }))
    );
    await waitForDom(() => document.querySelector('[role="dialog"]') !== null, { timeoutMs: 2000 });
    expect(document.querySelector('input[placeholder="Search the docs…"]')).not.toBeNull();
    await waitForDom(() => requests === 1, { timeoutMs: 2000 });
    await act(() =>
      window.dispatchEvent(new KeyboardEvent("keydown", { ctrlKey: true, key: "k" }))
    );
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    await act(() => container.querySelector("button")?.click());
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    expect(requests).toBe(1);
  } finally {
    await act(() => root.unmount());
    container.remove();
    globalThis.fetch = originalFetch;
  }
});

import "../../setup/global.ts";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { toCrossJSON } from "seroval";
import { fetchPageState, type PageFetchContext } from "../../../src/client/router/page-fetch.ts";
import { installDom, resetDomState, uninstallDom } from "../../support/dom.ts";

const TARGET_RE = /^\/target$/;
let originalFetch: typeof fetch;

beforeEach(() => {
  installDom();
  resetDomState();
  originalFetch = globalThis.fetch;
});

afterEach(async () => {
  globalThis.fetch = originalFetch;
  await uninstallDom();
});

const context: PageFetchContext = {
  basePath: "",
  captureHydration: () => undefined,
  currentMatch: () => null,
  rootBoundaries: undefined,
  routes: [
    {
      load: async () => ({ default: { _route: {} as never, component: () => null } }),
      pattern: "/target",
      regex: TARGET_RE,
    },
  ],
  staticMode: false,
};

function serve(body: object | Error): void {
  globalThis.fetch = Object.assign(
    () =>
      body instanceof Error
        ? Promise.reject(body)
        : Promise.resolve(
            new Response(`${JSON.stringify(toCrossJSON(body))}\n`, {
              headers: { "Content-Type": "application/x-ndjson" },
            })
          ),
    originalFetch
  );
}

test("classifies loader data as a page", async () => {
  serve({ message: "hi" });
  const result = await fetchPageState(context, "/target", undefined, false);
  expect(result.kind).toBe("page");
  expect(result.kind === "page" && result.state.data.message).toBe("hi");
});

test("returns an in-app redirect target instead of a placeholder state", async () => {
  serve({ __furinRedirect: "/target?from=old" });
  expect(await fetchPageState(context, "/target", undefined, false)).toEqual({
    kind: "redirect",
    href: "/target?from=old",
  });
});

test("returns a typed hard navigation for redirects leaving the app and network failures", async () => {
  serve({ __furinRedirect: "https://elsewhere.example/target" });
  expect(await fetchPageState(context, "/target", undefined, false)).toEqual({
    kind: "hardNavigate",
    reason: "redirect-outside-app",
  });
  serve(new TypeError("Failed to fetch"));
  expect(await fetchPageState(context, "/target", undefined, false)).toEqual({
    kind: "hardNavigate",
    reason: "network-error",
  });
});

test("reports an aborted fetch as aborted, not as a failure", async () => {
  const controller = new AbortController();
  controller.abort();
  serve(new DOMException("aborted", "AbortError"));
  expect(await fetchPageState(context, "/target", controller.signal, false)).toEqual({
    kind: "aborted",
  });
});

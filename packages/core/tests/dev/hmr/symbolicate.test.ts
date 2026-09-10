import { afterEach, expect, test } from "bun:test";
import { symbolicateStack } from "../../../src/server/dev/symbolicate.ts";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

test("symbolicates Bun 1.4 root chunk URLs", async () => {
  globalThis.fetch = ((input: RequestInfo | URL) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith(".map")) {
      return Promise.resolve(
        Response.json({ mappings: "AAAA", names: [], sources: ["/src/page.tsx"], version: 3 })
      );
    }
    return Promise.resolve(new Response(`//# sourceMappingURL=${url.pathname}.map`));
  }) as typeof fetch;

  const result = await symbolicateStack({
    origin: "http://localhost:3000",
    stack: "Error\n    at Page (http://localhost:3000/chunk-a1b2.js:1:1)",
  });

  expect(result.location?.file).toBe("/src/page.tsx");
});

test("evicts old source maps as HMR chunk URLs change", async () => {
  const requests = new Map<string, number>();
  globalThis.fetch = ((input: RequestInfo | URL) => {
    const url = String(input);
    requests.set(url, (requests.get(url) ?? 0) + 1);
    if (url.endsWith(".map")) {
      return Promise.resolve(
        Response.json({ mappings: "AAAA", names: [], sources: ["/src/page.tsx"], version: 3 })
      );
    }
    return Promise.resolve(new Response(`//# sourceMappingURL=${new URL(url).pathname}.map`));
  }) as typeof fetch;

  await Promise.all(
    Array.from({ length: 101 }, (_, index) =>
      symbolicateStack({
        origin: "http://localhost:3000",
        stack: `Error\n    at Page (http://localhost:3000/chunk-${index}.js:1:1)`,
      })
    )
  );
  await symbolicateStack({
    origin: "http://localhost:3000",
    stack: "Error\n    at Page (http://localhost:3000/chunk-0.js:1:1)",
  });

  expect(requests.get("http://localhost:3000/chunk-0.js")).toBe(2);
});

import { afterEach, expect, test } from "bun:test";
import { symbolicateStack } from "../../../src/server/dev/symbolicate.ts";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

test.each([
  "Page@http://localhost:3000/_bun/client/webkit.js:1:1",
  "@http://localhost:3000/_bun/client/webkit.js:1:1",
  "after@http://localhost:3000/_bun/client/webkit.js.map:1:1",
])("symbolicates WebKit initial and hot frames: %s", async (stack) => {
  globalThis.fetch = ((input: RequestInfo | URL) =>
    Promise.resolve(
      String(input).endsWith(".map")
        ? Response.json({ mappings: "AAAA", names: [], sources: ["/src/card.tsx"], version: 3 })
        : new Response("//# sourceMappingURL=webkit.js.map")
    )) as typeof fetch;

  const result = await symbolicateStack({ origin: "http://localhost:3000", stack });

  expect(result.location).toEqual({ column: 1, file: "/src/card.tsx", line: 1 });
  expect(result.frames).toHaveLength(1);
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

test("ignores source map directive text inside Bun's generated code strings", async () => {
  const requests: string[] = [];
  globalThis.fetch = ((input: RequestInfo | URL) => {
    const url = String(input);
    requests.push(url);
    if (url.endsWith("directive-decoy.js")) {
      return Promise.resolve(
        new Response(
          "const code = `\n//# sourceMappingURL=` + sourceMap;\n//# sourceMappingURL=actual.js.map\n"
        )
      );
    }
    return Promise.resolve(
      url.endsWith("actual.js.map")
        ? Response.json({ mappings: "AAAA", names: [], sources: ["/src/card.tsx"], version: 3 })
        : new Response("Not found", { status: 404 })
    );
  }) as typeof fetch;

  const result = await symbolicateStack({
    origin: "http://localhost:3000",
    stack: "    at Card (http://localhost:3000/_bun/client/directive-decoy.js:1:1)",
  });

  expect(result.location?.file).toBe("/src/card.tsx");
  expect(requests).toEqual([
    "http://localhost:3000/_bun/client/directive-decoy.js",
    "http://localhost:3000/_bun/client/actual.js.map",
  ]);
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

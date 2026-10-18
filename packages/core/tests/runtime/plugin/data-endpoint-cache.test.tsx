import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { defineRootRoute, defineRoute, HeadContent, Scripts } from "../../../src/furin.ts";
import { __resetCacheState } from "../../../src/server/cache/index.ts";
import { __resetCompileContext } from "../../../src/server/internal.ts";
import { __setDevMode, IS_DEV } from "../../../src/server/runtime-env.ts";
import { parseDeferredNdjson } from "../../../src/shared/deferred-ndjson.ts";
import { mountProductionApp, type ProductionPage } from "../../support/production-app.ts";

const originalDevMode = IS_DEV;
const rootTerminal = defineRootRoute()
  .config({ mode: "ssr" })
  .layout(({ children }) => (
    <html lang="en">
      <head>
        <HeadContent />
      </head>
      <body>
        {children}
        <Scripts />
      </body>
    </html>
  ));

/** Serves `route` at `pattern` through a production `furin()` and fetches its navigation data. */
async function fetchData(route: ProductionPage["route"], pattern: string): Promise<Response> {
  const { app } = await mountProductionApp({
    buildId: "build",
    pages: [{ pattern, requestKeys: pattern === "/account" ? ["user"] : [], route }],
    root: rootTerminal,
  });
  return app.handle(
    new Request(`http://localhost${pattern}?_furin=data`, {
      headers: { cookie: "session=alice" },
    })
  );
}

beforeAll(async () => {
  __setDevMode(false);
  await Promise.resolve();
});

afterEach(() => {
  __resetCacheState();
  __resetCompileContext();
});

afterAll(async () => {
  __setDevMode(originalDevMode);
  await Promise.resolve();
});

describe("navigation data cache contract", () => {
  test("loader redirects preserve external destinations and response cookies", async () => {
    const cookie = "session=; Max-Age=0; Path=/";
    const route = defineRoute()
      .config({ layout: rootTerminal, mode: "ssr" })
      .loader(() => {
        throw new Response(null, {
          headers: {
            location: "https://auth.example/authorize?client=furin",
            "set-cookie": cookie,
          },
          status: 302,
        });
      })
      .page(() => null);

    const response = await fetchData(route, "/logout");
    if (response.body === null) {
      throw new Error("Missing navigation payload");
    }
    const payload = await parseDeferredNdjson(response.body, undefined);
    expect(payload.syncData.__furinRedirect).toBe("https://auth.example/authorize?client=furin");
    expect(response.headers.get("set-cookie")).toBe(cookie);
    expect(response.headers.get("location")).toBeNull();
    expect(response.headers.get("cache-control")).toBe("private, no-store");
  });

  test("caches SSG payloads for one year under the page cache tag", async () => {
    const route = defineRoute()
      .config({ layout: rootTerminal, mode: "ssg" })
      .loader(() => ({ value: "static" }))
      .page(() => null);

    const response = await fetchData(route, "/catalog");

    expect(response.headers.get("cache-control")).toBe(
      "public, max-age=0, must-revalidate, s-maxage=31536000"
    );
    expect(response.headers.get("cache-tag")).toBe("/catalog");
  });

  test("caches ISR payloads with the route revalidation window", async () => {
    const route = defineRoute()
      .config({ layout: rootTerminal, mode: "isr", revalidate: 75 })
      .loader(() => ({ value: "fresh" }))
      .page(() => null);

    const response = await fetchData(route, "/news");

    expect(response.headers.get("cache-control")).toBe(
      "public, max-age=0, s-maxage=75, stale-while-revalidate=75"
    );
    expect(response.headers.get("cache-tag")).toBe("/news");
  });

  test("never caches request-specific ISR payloads", async () => {
    const route = defineRoute()
      .config({ layout: rootTerminal, mode: "isr", revalidate: 75 })
      .requestLoader(({ cookies }) => ({ user: cookies.get("session") }))
      .loader(() => ({ value: "public" }))
      .page(() => null);

    const response = await fetchData(route, "/account");

    expect(response.status).toBe(200);
    if (response.body === null) {
      throw new Error("Missing navigation payload");
    }
    const payload = await parseDeferredNdjson(response.body, undefined);
    expect(payload.syncData.value).toBe("public");
    expect(await payload.deferredPromises.user).toBe("alice");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("cache-tag")).toBeNull();
  });

  test("never caches failed ISR payloads", async () => {
    const route = defineRoute()
      .config({ layout: rootTerminal, mode: "isr", revalidate: 75 })
      .loader(() => {
        throw new Error("loader failed");
      })
      .page(() => null);

    const response = await fetchData(route, "/broken");

    expect(response.status).toBe(500);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("cache-tag")).toBeNull();
  });
});

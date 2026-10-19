import { afterAll, afterEach, expect, test } from "bun:test";
import { defineRootRoute, defineRoute, HeadContent, Scripts } from "../../../src/furin.ts";
import { __resetCacheState } from "../../../src/server/cache/index.ts";
import { __resetCompileContext } from "../../../src/server/internal.ts";
import { __setDevMode, IS_DEV } from "../../../src/server/runtime-env.ts";
import { mountProductionApp } from "../../support/production-app.ts";

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

afterEach(() => {
  __resetCacheState();
  __resetCompileContext();
});

afterAll(() => {
  __setDevMode(originalDevMode);
});

test("a production runtime keeps sanitizing errors after the default mode becomes development", async () => {
  __setDevMode(false);
  const route = defineRoute("/")
    .config({ mode: "ssr" })
    .page(() => {
      throw new Error("database password leaked");
    });
  const { app } = await mountProductionApp({
    buildId: "build",
    pages: [{ pattern: "/broken", route }],
    root: rootTerminal,
  });

  __setDevMode(true);
  const response = await app.handle(new Request("http://localhost/broken"));
  const html = await response.text();

  expect(response.status).toBe(500);
  expect(html).toContain("An unexpected error occurred.");
  expect(html).not.toContain("database password leaked");
});

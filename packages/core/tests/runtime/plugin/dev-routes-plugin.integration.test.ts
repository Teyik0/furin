import { expect, test } from "bun:test";
import { join } from "node:path";
import { type AnyElysia, Elysia } from "elysia";
import { registerDevRoutesPlugin } from "../../../src/plugin/dev-routes.ts";
import { routeModuleSpecifier } from "../../../src/plugin/route-tree.ts";

// Route apps refuse to render outside furin(); echo what the renderer receives.
function withEchoRenderer(furinApp: AnyElysia) {
  return new Elysia()
    .decorate("$furinRender", (context: { params: unknown; route: string }) =>
      Response.json({ params: context.params, rendered: true, route: context.route })
    )
    .use(furinApp);
}

test("a runtime plugin registered earlier cannot claim the route module", async () => {
  const instance = {
    pagesDir: join(import.meta.dir, "../../fixtures/routes-v2/root"),
    prefix: "/claimed",
  };
  const specifier = routeModuleSpecifier(instance);
  const query = specifier.slice(specifier.indexOf("?"));
  // An application plugin whose filter happens to match the module's file path.
  Bun.plugin({
    name: "claims-route-module",
    setup(build) {
      build.onLoad({ filter: new RegExp(`routes\\.ts\\${query}$`) }, () => ({
        contents: "export const furinApp = undefined;",
        loader: "ts",
      }));
    },
  });
  registerDevRoutesPlugin([instance]);

  const module = (await import(specifier)) as { furinApp: AnyElysia | undefined };

  expect(module.furinApp).toBeDefined();
});

test("the dev runtime resolves a composed Elysia app from the stable route specifier", async () => {
  const instance = {
    pagesDir: join(import.meta.dir, "../../fixtures/routes-v2/root"),
    prefix: "",
  };
  registerDevRoutesPlugin([instance]);

  const module = (await import(routeModuleSpecifier(instance))) as {
    furinApp: AnyElysia;
  };
  const response = await withEchoRenderer(module.furinApp).handle(
    new Request("http://localhost/boards/42")
  );

  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({
    params: { id: "42" },
    rendered: true,
    route: "/boards/:id",
  });
});

test("the dev runtime serves nested groups through their own layout chains", async () => {
  const instance = {
    pagesDir: join(import.meta.dir, "../../fixtures/pages/route-groups"),
    prefix: "",
  };
  registerDevRoutesPlugin([instance]);

  const module = (await import(routeModuleSpecifier(instance))) as {
    furinApp: AnyElysia;
  };
  const app = withEchoRenderer(module.furinApp);
  const admin = await app.handle(new Request("http://localhost/users/42"));
  expect(admin.status).toBe(200);
  expect(await admin.json()).toEqual({ params: { id: "42" }, rendered: true, route: "/users/:id" });
  const marketing = await app.handle(new Request("http://localhost/"));
  expect(marketing.status).toBe(200);
  expect(await marketing.json()).toMatchObject({ rendered: true });
});

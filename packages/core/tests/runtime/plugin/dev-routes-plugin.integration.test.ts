import { expect, test } from "bun:test";
import { join } from "node:path";
import { registerDevRoutesPlugin, routeModuleSpecifier } from "../../../src/plugin/routes.ts";

test("the dev runtime resolves a composed Elysia app from the stable route specifier", async () => {
  const instance = {
    pagesDir: join(import.meta.dir, "../../fixtures/routes-v2/root"),
    prefix: "",
  };
  registerDevRoutesPlugin([instance]);

  const module = (await import(routeModuleSpecifier(instance))) as {
    furinApp: { handle: (request: Request) => Promise<Response> };
  };
  const response = await module.furinApp.handle(new Request("http://localhost/boards/42"));

  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ board: "42", user: "teyik" });
});

test("the dev runtime serves nested groups with isolated layout loaders", async () => {
  const instance = {
    pagesDir: join(import.meta.dir, "../../fixtures/pages/route-groups"),
    prefix: "",
  };
  registerDevRoutesPlugin([instance]);

  const module = (await import(routeModuleSpecifier(instance))) as {
    furinApp: { handle: (request: Request) => Promise<Response> };
  };
  const admin = await module.furinApp.handle(new Request("http://localhost/users/42"));
  expect(admin.status).toBe(200);
  expect(await admin.json()).toEqual({ group: "admin", id: "42" });
  const marketing = await module.furinApp.handle(new Request("http://localhost/"));
  expect(marketing.status).toBe(200);
  expect(await marketing.json()).toEqual({ group: "marketing" });
});

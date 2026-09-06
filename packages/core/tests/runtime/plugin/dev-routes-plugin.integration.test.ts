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

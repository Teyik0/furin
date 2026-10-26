import { expect, test } from "bun:test";
import { Elysia } from "elysia";
import { desktopApp, desktopContext } from "../src/server";

test("independent desktop API receives null in web mode without registering a root", async () => {
  const api = new Elysia().use(desktopContext).get("/desktop", ({ desktop }) => ({ desktop }));
  const app = new Elysia()
    .use(desktopApp({ window: { title: "Test", frame: { width: 800, height: 600 } } }))
    .use(api);
  expect(await (await app.handle(new Request("http://localhost/desktop"))).json()).toEqual({
    desktop: null,
  });
});

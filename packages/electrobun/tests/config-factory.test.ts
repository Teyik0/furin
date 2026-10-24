import { expect, expectTypeOf, test } from "bun:test";
import { treaty } from "@elysia/eden";
import { Elysia } from "elysia";
import type { DesktopContext } from "../src/capabilities";
import { desktopApp } from "../src/server";

test("desktop configuration infers preceding service decorators and shared state", async () => {
  const accessService = {
    token: "allowed",
    admit(request: Request) {
      if (request.headers.get("authorization") !== this.token) {
        return new Response("Forbidden", { status: 403 });
      }
    },
  };
  const services = new Elysia({ name: "services" })
    .decorate({ access: accessService, instance: { name: "Relay" } })
    .derive("global", () => ({ requestOnly: "request" }));
  let configurations = 0;
  const root = new Elysia({ prefix: "/api" })
    .state("title", "Desktop")
    .use(services)
    .get("/before", () => ({ ready: true }));
  const app = root
    .use(
      desktopApp((context) => {
        const { access, instance, store } = context;
        expectTypeOf(access).toEqualTypeOf<
          (typeof services)["~Singleton"]["decorator"]["access"]
        >();
        expectTypeOf(instance.name).toEqualTypeOf<string>();
        expectTypeOf(store.title).toEqualTypeOf<string>();
        expectTypeOf(context).not.toHaveProperty("request");
        expectTypeOf(context).not.toHaveProperty("missing");
        expectTypeOf(context).not.toHaveProperty("requestOnly");
        configurations += 1;
        return {
          admission: access.admit.bind(access),
          window: { title: `${instance.name} ${store.title}` },
        };
      })
    )
    .get("/probe/:id", ({ desktop, instance, params }) => {
      expectTypeOf(desktop).toEqualTypeOf<DesktopContext | null>();
      expectTypeOf(params.id).toEqualTypeOf<string>();
      return { name: instance.name, id: params.id };
    });
  const api = treaty(app);
  expectTypeOf<Awaited<ReturnType<typeof api.api.before.get>>["data"]>().toEqualTypeOf<{
    ready: boolean;
  } | null>();
  // @ts-expect-error the desktop plugin must preserve the root's route types
  expect(api.missing).toBeDefined();
  expect(Object.is(app, root)).toBe(true);
  expect(configurations).toBe(1);
  try {
    await new Promise<void>((resolve) => {
      app.listen({ hostname: "127.0.0.1", port: 0 }, () => resolve());
    });
    const url = `http://127.0.0.1:${app.server?.port}/api/probe/42`;
    expect((await fetch(url)).status).toBe(403);
    const response = await fetch(url, { headers: { authorization: "allowed" } });
    expect(await response.json()).toEqual({ name: "Relay", id: "42" });
    expect(configurations).toBe(1);
  } finally {
    await app.stop(true);
  }
});

test("explicit application configuration preserves services, shared references and desktop context", async () => {
  const settings = { background: false };
  const services = new Elysia().decorate("instance", { name: "Relay" });
  const root = new Elysia().use(services).state("settings", settings);
  let background: (() => boolean) | undefined;
  let title: string | undefined;
  const app = root
    .use((parent) =>
      desktopApp(parent, ({ instance, store }) => {
        expectTypeOf(instance.name).toEqualTypeOf<string>();
        expectTypeOf(store.settings.background).toEqualTypeOf<boolean>();
        title = instance.name;
        background = () => store.settings.background;
        return { background, window: { title } };
      })
    )
    .get("/", ({ desktop, instance }) => {
      expectTypeOf(desktop).toEqualTypeOf<DesktopContext | null>();
      return { desktop, name: instance.name };
    });

  expect(Object.is(app, root)).toBe(true);
  expect(title).toBe("Relay");
  expect(background?.()).toBe(false);
  settings.background = true;
  expect(background?.()).toBe(true);
  expect(await (await app.handle(new Request("http://localhost/"))).json()).toEqual({
    desktop: null,
    name: "Relay",
  });
});

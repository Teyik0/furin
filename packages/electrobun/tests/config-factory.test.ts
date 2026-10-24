import { expect, expectTypeOf, test } from "bun:test";
import { treaty } from "@elysia/eden";
import { Elysia, t } from "elysia";
import type { DesktopAppOptions, DesktopContext } from "../src/capabilities";
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
  let background: boolean | undefined;
  let configuredSettings: typeof settings | undefined;
  let title: string | undefined;
  const app = root
    .use((parent) =>
      desktopApp(parent, ({ instance, store }) => {
        expectTypeOf(instance.name).toEqualTypeOf<string>();
        expectTypeOf(store.settings.background).toEqualTypeOf<boolean>();
        title = instance.name;
        ({ background } = store.settings);
        configuredSettings = store.settings;
        return { background, window: { title } };
      })
    )
    .get("/", ({ desktop, instance }) => {
      expectTypeOf(desktop).toEqualTypeOf<DesktopContext | null>();
      return { desktop, name: instance.name };
    });

  expect(Object.is(app, root)).toBe(true);
  expect(title).toBe("Relay");
  expectTypeOf<DesktopAppOptions["background"]>().toEqualTypeOf<boolean | undefined>();
  expect(configuredSettings).toBe(settings);
  expect(background).toBe(false);
  settings.background = true;
  expect(configuredSettings?.background).toBe(true);
  expect(background).toBe(false);
  expect(await (await app.handle(new Request("http://localhost/"))).json()).toEqual({
    desktop: null,
    name: "Relay",
  });
});

test("desktop configuration after an API plugin preserves macros, routes and lifecycle methods", async () => {
  const accessService = {
    admit: (_request: Request): Response | undefined => undefined,
  };
  const torrentsService = { settings: { runInBackground: true } };
  const apiPlugin = new Elysia({ prefix: "/api" })
    .decorate({ access: accessService, torrents: torrentsService })
    .macro({
      session: {
        derive({ request, status }) {
          if (!request.headers.has("x-session")) {
            return status(401, { error: "Sign in" });
          }
          return { user: { role: "admin" as const } };
        },
      },
    })
    .get(
      "/items/:id",
      { session: true, params: t.Object({ id: t.Number() }) },
      ({ params, user }) => ({ id: params.id, role: user.role })
    );
  let closed = 0;
  const closeResources = () => {
    closed += 1;
  };
  const app = new Elysia()
    .use(apiPlugin)
    .use(
      desktopApp(({ access, torrents }) => {
        expectTypeOf(access).toEqualTypeOf<typeof accessService>();
        expectTypeOf(torrents).toEqualTypeOf<typeof torrentsService>();
        return {
          admission: access.admit.bind(access),
          background: torrents.settings.runInBackground,
        };
      })
    )
    .onStop(closeResources)
    .get(
      "/after/:id",
      { session: true, params: t.Object({ id: t.Number() }) },
      ({ access, desktop, params, torrents, user }) => {
        expectTypeOf(access).toEqualTypeOf<typeof accessService>();
        expectTypeOf(desktop).toEqualTypeOf<DesktopContext | null>();
        expectTypeOf(params.id).toEqualTypeOf<number>();
        expectTypeOf(torrents).toEqualTypeOf<typeof torrentsService>();
        expectTypeOf(user.role).toEqualTypeOf<"admin">();
        return { id: params.id, role: user.role };
      }
    );
  expectTypeOf(app).not.toBeNever();
  expectTypeOf(app).not.toBeAny();
  const client = treaty(app);
  expectTypeOf<
    Awaited<ReturnType<ReturnType<typeof client.api.items>["get"]>>["data"]
  >().toEqualTypeOf<{
    id: number;
    role: "admin";
  } | null>();
  // @ts-expect-error the API plugin's routes must remain typed
  expect(client.missing).toBeDefined();
  try {
    await new Promise<void>((resolve) => {
      app.listen({ hostname: "127.0.0.1", port: 0 }, () => resolve());
    });
    const origin = `http://127.0.0.1:${app.server?.port}`;
    const headers = { "x-session": "active" };
    expect((await fetch(`${origin}/after/7`)).status).toBe(401);
    expect(await (await fetch(`${origin}/api/items/42`, { headers })).json()).toEqual({
      id: 42,
      role: "admin",
    });
    expect(await (await fetch(`${origin}/after/7`, { headers })).json()).toEqual({
      id: 7,
      role: "admin",
    });
  } finally {
    await app.stop(true);
  }
  expect(closed).toBe(1);
});

import { expect, test } from "bun:test";
import { Elysia } from "elysia";
import { loadServerEntry } from "../../src/server/server-entry.ts";

test("captured listen options survive inert imports and override serve defaults", async () => {
  const app = new Elysia({
    serve: { hostname: "0.0.0.0", port: 3000, idleTimeout: 10 },
  }).get("/", () => "ready");
  let starts = 0;
  app.onStart(() => {
    starts += 1;
  });
  const module = await loadServerEntry(() => {
    app.listen({ hostname: "127.0.0.1", port: 0, idleTimeout: 20 });
    return Promise.resolve({});
  });
  expect(module.default).toBe(app);
  expect(app.server).toBeUndefined();
  expect(starts).toBe(0);
  try {
    await new Promise<void>((resolve) => app.listen({}, () => resolve()));
    const { server } = app;
    if (!server) {
      throw new Error("Expected the captured listener to start.");
    }
    expect(server.hostname).toBe("127.0.0.1");
    expect(starts).toBe(1);
    expect(await (await fetch(server.url)).text()).toBe("ready");
  } finally {
    await app.stop(true);
  }
});

test.each([0, "0"])("captured listen(%j) overrides the configured port", async (port) => {
  const app = new Elysia({ serve: { hostname: "127.0.0.1", port: -1 } });
  await loadServerEntry(() => Promise.resolve({ default: app.listen(port) }));
  expect(app.server).toBeUndefined();
  try {
    await new Promise<void>((resolve) => app.listen({}, () => resolve()));
    expect(app.server?.hostname).toBe("127.0.0.1");
    expect(app.server?.port).toBeGreaterThan(0);
  } finally {
    await app.stop(true);
  }
});

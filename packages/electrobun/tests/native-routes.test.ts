import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Elysia } from "elysia";
import { WebStandardAdapter } from "elysia/adapter/web-standard";
import { startDesktopBackend } from "../src/runtime";
import { createDesktopApp } from "../src/server";
import html from "./fixtures/hmr.html";

test("startup preserves native policy and cleanup failures while closing the listener once", async () => {
  const data = await mkdtemp(join(tmpdir(), "furin-startup-errors-"));
  const previousData = process.env.FURIN_APP_DATA_DIR;
  const cleanupError = new Error("module cleanup failed");
  let shutdowns = 0;
  const app = createDesktopApp().setup((root) => {
    root.get("/private-html", html);
  });
  try {
    const failure: unknown = await startDesktopBackend(
      () =>
        Promise.resolve({
          default: app,
          onShutdown: () => {
            shutdowns += 1;
            throw cleanupError;
          },
        }),
      data,
      "build"
    ).then(
      () => undefined,
      (error: unknown) => error
    );
    expect(failure).toBeInstanceOf(AggregateError);
    if (!(failure instanceof AggregateError)) {
      throw new Error("Expected both startup and cleanup errors.");
    }
    const original: unknown = failure.errors[0];
    expect(original).toBeInstanceOf(Error);
    if (!(original instanceof Error)) {
      throw new Error("Expected original policy error.");
    }
    expect(original.message).toContain('"/private-html"');
    expect(failure.cause).toBe(original);
    expect(failure.errors).toEqual([original, cleanupError]);
    expect(shutdowns).toBe(1);
    expect(app.server).toBeUndefined();
  } finally {
    await app.stop(true);
    if (previousData === undefined) {
      delete process.env.FURIN_APP_DATA_DIR;
    } else {
      process.env.FURIN_APP_DATA_DIR = previousData;
    }
    await rm(data, { recursive: true, force: true });
  }
});

test("custom adapters retain normal web use but are refused for desktop dispatch", async () => {
  const data = await mkdtemp(join(tmpdir(), "furin-custom-adapter-"));
  const previousData = process.env.FURIN_APP_DATA_DIR;
  const app = createDesktopApp({ adapter: WebStandardAdapter }).get("/", () => "web");
  try {
    expect(await (await app.handle("http://web.test/")).text()).toBe("web");
    await expect(
      startDesktopBackend(() => Promise.resolve({ default: app }), data, "build")
    ).rejects.toThrow("default Bun adapter");
    expect(app.server).toBeUndefined();
  } finally {
    if (previousData === undefined) {
      delete process.env.FURIN_APP_DATA_DIR;
    } else {
      process.env.FURIN_APP_DATA_DIR = previousData;
    }
    await rm(data, { recursive: true, force: true });
  }
});

for (const nested of [false, true]) {
  test(`build fails closed when ${nested ? "nested " : ""}source setup adds a native HTML bundle`, async () => {
    const data = await mkdtemp(join(tmpdir(), "furin-late-native-"));
    const previousData = process.env.FURIN_APP_DATA_DIR;
    let added = false;
    const app = createDesktopApp().setup((root) => {
      const add = () => {
        root.get("/private-html", html);
        added = true;
      };
      if (nested) {
        root.setup(add);
      } else {
        add();
      }
    });
    let backend: Awaited<ReturnType<typeof startDesktopBackend>> | undefined;
    try {
      const result = await startDesktopBackend(
        () => Promise.resolve({ default: app }),
        data,
        "build"
      ).then(
        (value) => {
          backend = value;
          return "unexpected readiness";
        },
        (error: Error) => error.message
      );
      expect(result).toContain('"/private-html"');
      expect(added).toBe(true);
      expect(app.server).toBeUndefined();
    } finally {
      await backend?.stop();
      await app.stop(true);
      if (previousData === undefined) {
        delete process.env.FURIN_APP_DATA_DIR;
      } else {
        process.env.FURIN_APP_DATA_DIR = previousData;
      }
      await rm(data, { recursive: true, force: true });
    }
  });
}

test("queued unauthenticated traffic cannot receive a late native HTML bundle before failed startup closes", async () => {
  const data = await mkdtemp(join(tmpdir(), "furin-native-queue-"));
  const previousData = process.env.FURIN_APP_DATA_DIR;
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const app = createDesktopApp().setup(async (root) => {
    entered.resolve();
    await release.promise;
    root.get("/private-html", html);
  });
  const startup = startDesktopBackend(() => Promise.resolve({ default: app }), data, "build").then(
    () => "unexpected readiness",
    (error: Error) => error.message
  );
  try {
    await entered.promise;
    const url = `http://127.0.0.1:${app.server?.port}/private-html`;
    const traffic = Array.from({ length: 16 }, () =>
      fetch(url).then(
        (response) => response.text(),
        () => "connection closed"
      )
    );
    await Bun.sleep(20);
    release.resolve();
    expect(await startup).toContain('"/private-html"');
    const responses = await Promise.all(traffic);
    expect(responses.some((body) => body.includes("frontend fixture"))).toBe(false);
    expect(app.server).toBeUndefined();
  } finally {
    release.resolve();
    await startup;
    await app.stop(true);
    if (previousData === undefined) {
      delete process.env.FURIN_APP_DATA_DIR;
    } else {
      process.env.FURIN_APP_DATA_DIR = previousData;
    }
    await rm(data, { recursive: true, force: true });
  }
});

test("build rejects even reserved native HMR HTML bundles before listen", async () => {
  const data = await mkdtemp(join(tmpdir(), "furin-native-build-"));
  const previousData = process.env.FURIN_APP_DATA_DIR;
  const app = createDesktopApp().get("/_bun_hmr_entry", html);
  try {
    await expect(
      startDesktopBackend(() => Promise.resolve({ default: app }), data, "build")
    ).rejects.toThrow("never in build");
    expect(app.server).toBeUndefined();
  } finally {
    if (previousData === undefined) {
      delete process.env.FURIN_APP_DATA_DIR;
    } else {
      process.env.FURIN_APP_DATA_DIR = previousData;
    }
    await rm(data, { recursive: true, force: true });
  }
});

test("dev rejects arbitrary native HTML routes including async plugins", async () => {
  const data = await mkdtemp(join(tmpdir(), "furin-native-dev-"));
  const previousData = process.env.FURIN_APP_DATA_DIR;
  const app = createDesktopApp().use(Promise.resolve(new Elysia().get("/private", html)));
  try {
    await expect(
      startDesktopBackend(() => Promise.resolve({ default: app }), data, "dev")
    ).rejects.toThrow('"/private"');
    expect(app.server).toBeUndefined();
  } finally {
    if (previousData === undefined) {
      delete process.env.FURIN_APP_DATA_DIR;
    } else {
      process.env.FURIN_APP_DATA_DIR = previousData;
    }
    await rm(data, { recursive: true, force: true });
  }
});

test("explicit serve.routes is rejected instead of claiming native responses are guarded", async () => {
  const data = await mkdtemp(join(tmpdir(), "furin-native-config-"));
  const previousData = process.env.FURIN_APP_DATA_DIR;
  const app = createDesktopApp({ serve: { routes: { "/native": new Response("native") } } });
  try {
    await expect(
      startDesktopBackend(() => Promise.resolve({ default: app }), data, "build")
    ).rejects.toThrow("serve.routes");
    expect(app.server).toBeUndefined();
  } finally {
    if (previousData === undefined) {
      delete process.env.FURIN_APP_DATA_DIR;
    } else {
      process.env.FURIN_APP_DATA_DIR = previousData;
    }
    await rm(data, { recursive: true, force: true });
  }
});

test("dev permits only reserved frontend HTML assets while app dispatch still requires session", async () => {
  const data = await mkdtemp(join(tmpdir(), "furin-native-assets-"));
  const previousData = process.env.FURIN_APP_DATA_DIR;
  const app = createDesktopApp()
    .get("/admin/_bun_hmr_entry/index.html", html)
    .get("/api", () => "private");
  const backend = await startDesktopBackend(() => Promise.resolve({ default: app }), data, "dev");
  try {
    // This is an explicit development-only exemption, NOT an authenticated route.
    expect(
      await (await fetch(`${backend.origin}/admin/_bun_hmr_entry/index.html`)).text()
    ).toContain("frontend fixture");
    expect((await fetch(`${backend.origin}/api`)).status).toBe(403);
  } finally {
    await backend.stop();
    if (previousData === undefined) {
      delete process.env.FURIN_APP_DATA_DIR;
    } else {
      process.env.FURIN_APP_DATA_DIR = previousData;
    }
    await rm(data, { recursive: true, force: true });
  }
});

test("build disables native development routes and protects static Responses", async () => {
  const data = await mkdtemp(join(tmpdir(), "furin-promoted-"));
  const previousData = process.env.FURIN_APP_DATA_DIR;
  const app = createDesktopApp({ nativeStaticResponse: true }).get("/constant", "constant");
  const backend = await startDesktopBackend(() => Promise.resolve({ default: app }), data, "build");
  try {
    expect(app.server?.development).toBe(false);
    expect((await fetch(`${backend.origin}/constant`)).status).toBe(403);
    const bootstrap = await fetch(backend.url, { redirect: "manual" });
    const cookie = bootstrap.headers.get("set-cookie")?.split(";")[0];
    if (!cookie) {
      throw new Error("Missing desktop cookie.");
    }
    expect(await (await fetch(`${backend.origin}/constant`, { headers: { cookie } })).text()).toBe(
      "constant"
    );
  } finally {
    await backend.stop();
    if (previousData === undefined) {
      delete process.env.FURIN_APP_DATA_DIR;
    } else {
      process.env.FURIN_APP_DATA_DIR = previousData;
    }
    await rm(data, { recursive: true, force: true });
  }
});

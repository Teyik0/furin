import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { treaty } from "@elysia/eden";
import { Elysia } from "elysia";
import { startDesktopBackend } from "../src/runtime";
import { type AdmissionContext, desktopApp, dispatchKind } from "../src/server";
import { standardLaunchFixture, waitForFixture } from "./fixtures/standard-launch";

test("admission authenticates listener requests that lack the desktop session; in-process dispatch bypasses it", async () => {
  const data = await mkdtemp(join(tmpdir(), "furin-admission-"));
  const previous = process.env.FURIN_APP_DATA_DIR;
  const admitted: AdmissionContext[] = [];
  const app = new Elysia({ serve: { hostname: "0.0.0.0" } })
    .use(
      desktopApp({
        admission(request, context) {
          admitted.push(context);
          if (context.desktopSession || request.headers.get("authorization") === "Bearer remote") {
            return;
          }
          return new Response("Sign in", { status: 401 });
        },
      })
    )
    .get("/api/kind", ({ request }) => ({ kind: dispatchKind(request) }));
  let backend: Awaited<ReturnType<typeof startDesktopBackend>> | undefined;
  try {
    backend = await startDesktopBackend(() => Promise.resolve({ default: app }), data, "build");
    expect(app.server?.hostname).toBe("0.0.0.0");
    expect(backend.origin).toStartWith("http://127.0.0.1:");
    const anonymous = await fetch(`${backend.origin}/api/kind`);
    expect(anonymous.status).toBe(401);
    expect(admitted.at(-1)).toEqual({
      desktopHost: true,
      desktopSession: false,
      peerAddress: "127.0.0.1",
    });

    const remote = await fetch(`${backend.origin}/api/kind`, {
      headers: { authorization: "Bearer remote" },
    });
    expect(await remote.json()).toEqual({ kind: "network" });

    const desktop = await fetch(`${backend.origin}/api/kind`, {
      headers: { cookie: backend.cookie, origin: backend.origin },
    });
    expect(await desktop.json()).toEqual({ kind: "network" });
    expect(admitted.at(-1)).toEqual({
      desktopHost: true,
      desktopSession: true,
      peerAddress: "127.0.0.1",
    });

    const calls = admitted.length;
    expect((await treaty(app).api.kind.get()).data).toEqual({ kind: "in-process" });
    expect(admitted).toHaveLength(calls);
  } finally {
    try {
      await backend?.stop();
    } finally {
      if (previous === undefined) {
        delete process.env.FURIN_APP_DATA_DIR;
      } else {
        process.env.FURIN_APP_DATA_DIR = previous;
      }
      await rm(data, { recursive: true, force: true });
    }
  }
});

test("the application chooses a stable desktop port and TLS; TLS windows receive the session natively", async () => {
  const data = await mkdtemp(join(tmpdir(), "furin-listen-"));
  const previous = process.env.FURIN_APP_DATA_DIR;
  const cert = await Bun.file(join(import.meta.dir, "fixtures/tls-cert.pem")).text();
  const key = await Bun.file(join(import.meta.dir, "fixtures/tls-key.pem")).text();
  const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
  const { port } = probe;
  await probe.stop(true);
  const app = new Elysia({
    serve: { hostname: "127.0.0.1", port, tls: { cert, key } },
  })
    .use(desktopApp())
    .get("/api/scheme", ({ request }) => ({ protocol: new URL(request.url).protocol }));
  let backend: Awaited<ReturnType<typeof startDesktopBackend>> | undefined;
  try {
    backend = await startDesktopBackend(() => Promise.resolve({ default: app }), data, "build");
    expect(backend.origin).toBe(`https://127.0.0.1:${port}`);
    expect(backend.session?.secure).toBe(true);
    expect(backend.createWindowUrl("/options")).toBe(`https://127.0.0.1:${port}/options`);
    const call = (headers: { [name: string]: string }) =>
      fetch(`${backend?.origin}/api/scheme`, { headers, tls: { ca: cert } });
    expect((await call({})).status).toBe(403);
    const response = await call({ cookie: backend.cookie });
    expect(await response.json()).toEqual({ protocol: "https:" });
  } finally {
    try {
      await backend?.stop();
    } finally {
      if (previous === undefined) {
        delete process.env.FURIN_APP_DATA_DIR;
      } else {
        process.env.FURIN_APP_DATA_DIR = previous;
      }
      await rm(data, { recursive: true, force: true });
    }
  }
});

test("the standard host installs the TLS window session in the default partition before opening", async () => {
  const fixtureCertificate = join(import.meta.dir, "fixtures/tls-cert.pem");
  const fixtureKey = join(import.meta.dir, "fixtures/tls-key.pem");
  const fixture = await standardLaunchFixture({
    mode: "build",
    listen: `({ hostname: "127.0.0.1", port: 0, tls: {
      cert: require("node:fs").readFileSync(${JSON.stringify(fixtureCertificate)}, "utf8"),
      key: require("node:fs").readFileSync(${JSON.stringify(fixtureKey)}, "utf8"),
    } })`,
  });
  const host = fixture.launch();
  try {
    const backend = await waitForFixture(
      async () => {
        if (host.child.exitCode !== null) {
          throw new Error((await host.output).join("\n"));
        }
        const file = Bun.file(join(fixture.root, "backend.json"));
        return (await file.exists()) ? ((await file.json()) as { origin: string }) : undefined;
      },
      (value) => value !== undefined
    );
    await waitForFixture(() => Bun.file(join(fixture.root, "window-url")).exists(), Boolean);
    expect(backend?.origin.startsWith("https://127.0.0.1:")).toBe(true);
    expect(await Bun.file(join(fixture.root, "window-url")).text()).toBe(`${backend?.origin}/`);
    const [cookie] = (await Bun.file(join(fixture.root, "native-cookies")).text())
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(cookie).toMatchObject({
      partition: "persist:default",
      domain: "127.0.0.1",
      path: "/",
      secure: true,
      httpOnly: true,
      sameSite: "strict",
    });
    const response = await fetch(`${backend?.origin}/`, {
      headers: { cookie: `${cookie.name}=${cookie.value}` },
      tls: { ca: await Bun.file(fixtureCertificate).text() },
    });
    expect(response.status).toBe(200);
  } finally {
    await host.stop("SIGTERM");
    await fixture.close();
  }
}, 20_000);

test("headless admission sees every listener request and rejects forged listener identities", async () => {
  const seen: string[] = [];
  const app = new Elysia()
    .use(
      desktopApp({
        admission(request, context) {
          seen.push(`${new URL(request.url).pathname}:${context.desktopSession}`);
          return request.headers.has("x-allowed") ? undefined : new Response(null, { status: 401 });
        },
      })
    )
    .get("/api/kind", ({ request }) => dispatchKind(request));
  try {
    await new Promise<void>((resolve) =>
      app.listen({ hostname: "127.0.0.1", port: 0 }, () => resolve())
    );
    const origin = `http://127.0.0.1:${app.server?.port}`;
    expect((await fetch(`${origin}/api/kind`)).status).toBe(401);
    const allowed = await fetch(`${origin}/api/kind`, { headers: { "x-allowed": "1" } });
    expect(await allowed.text()).toBe("network");
    // A caller-supplied adapter argument that is not this listener fails closed.
    const dispatch = app.fetch as (request: Request, server: unknown) => Promise<Response>;
    const forged = await dispatch(
      new Request(`${origin}/api/kind`, { headers: { "x-allowed": "1" } }),
      { requestIP: () => ({ address: "127.0.0.1" }) }
    );
    expect(forged.status).toBe(403);
    expect(seen).toEqual(["/api/kind:false", "/api/kind:false"]);
  } finally {
    await app.stop(true);
  }
});

test("the host refuses to open when the native cookie API drops HttpOnly", async () => {
  const fixture = await standardLaunchFixture({
    mode: "build",
    listen: `({ hostname: "127.0.0.1", port: 0, tls: {cert: require("node:fs").readFileSync(${JSON.stringify(join(import.meta.dir, "fixtures/tls-cert.pem"))},"utf8"),key: require("node:fs").readFileSync(${JSON.stringify(join(import.meta.dir, "fixtures/tls-key.pem"))},"utf8")} })`,
  });
  const host = fixture.launch({ FURIN_FIXTURE_INSECURE_COOKIE: "1" });
  try {
    await waitForFixture(() => Bun.file(join(fixture.root, "native-cookies")).exists(), Boolean);
    await host.stop("SIGTERM");
    expect(await Bun.file(join(fixture.root, "window-url")).exists()).toBe(false);
    expect((await host.output).join("\n")).toContain("HttpOnly");
  } finally {
    await host.stop("SIGTERM");
    await fixture.close();
  }
}, 20_000);

test("headless TLS readiness retains the listener scheme", async () => {
  const ready = Promise.withResolvers<string>();
  const app = new Elysia()
    .use(desktopApp())
    .onStart((instance) => {
      const backend = { origin: instance.server?.url.origin ?? "" };
      ready.resolve(backend.origin);
    })
    .get("/", () => "ready");
  try {
    app.listen({
      hostname: "127.0.0.1",
      port: 0,
      tls: {
        cert: await Bun.file(join(import.meta.dir, "fixtures/tls-cert.pem")).text(),
        key: await Bun.file(join(import.meta.dir, "fixtures/tls-key.pem")).text(),
      },
    });
    expect(await ready.promise).toBe(`https://127.0.0.1:${app.server?.port}`);
  } finally {
    await app.stop(true);
  }
});

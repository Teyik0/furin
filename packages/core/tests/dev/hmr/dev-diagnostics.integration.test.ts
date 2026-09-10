// biome-ignore-all lint/performance/noAwaitInLoops: integration polling waits for the dev server
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { realpathSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { DevDiagnosticEvent } from "../../../src/shared/dev-diagnostics.ts";
import { createTmpApp, writeAppFile } from "../../support/app-fixtures.ts";
import { getFreePort } from "../../support/hmr.ts";
import { startProcess } from "../../support/process.ts";

interface EmbeddedDiagnosticState {
  basePath: string;
  event: {
    diagnostic: {
      cause: string | undefined;
      importChain: readonly string[];
      location: { file: string } | undefined;
      message: string;
      phase: string;
      route: string;
    };
    type: "error";
    version: number;
  };
}

interface DiagnosticEnvelope {
  channel: "diagnostic";
  data: DevDiagnosticEvent;
  version: 1;
}

interface DiagnosticSocket {
  close: () => void;
  next: (type: DevDiagnosticEvent["type"]) => Promise<DevDiagnosticEvent>;
}

const DIAGNOSTIC_STATE_RE =
  /<script id="__FURIN_DEV_DIAGNOSTIC__" type="application\/json">(.+?)<\/script>/;
const DIAGNOSTIC_EVENT_TIMEOUT_MS = 10_000;

async function openDiagnosticSocket(port: number): Promise<DiagnosticSocket> {
  const socket = new WebSocket(`ws://localhost:${port}/_furin/events`);
  const events: DevDiagnosticEvent[] = [];
  const waiters = new Set<{
    reject: (error: Error) => void;
    resolve: (event: DevDiagnosticEvent) => void;
    type: DevDiagnosticEvent["type"];
  }>();
  const rejectWaiters = (message: string): void => {
    for (const waiter of waiters) {
      waiter.reject(new Error(message));
    }
    waiters.clear();
  };
  socket.addEventListener("close", () => rejectWaiters("Diagnostic socket closed"));
  socket.addEventListener("error", () => rejectWaiters("Diagnostic socket failed"));
  socket.addEventListener("message", (message) => {
    const envelope = JSON.parse(String(message.data)) as DiagnosticEnvelope;
    if (envelope.channel !== "diagnostic") {
      return;
    }
    const waiter = [...waiters].find((candidate) => candidate.type === envelope.data.type);
    if (waiter) {
      waiters.delete(waiter);
      waiter.resolve(envelope.data);
    } else {
      events.push(envelope.data);
    }
  });
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("Timed out opening diagnostic socket")),
      2000
    );
    socket.addEventListener("open", () => {
      clearTimeout(timeout);
      resolve();
    });
    socket.addEventListener("error", () => {
      clearTimeout(timeout);
      reject(new Error("Diagnostic socket failed"));
    });
  });
  return {
    close: () => socket.close(),
    next(type) {
      const index = events.findIndex((event) => event.type === type);
      if (index >= 0) {
        const [event] = events.splice(index, 1);
        if (event) {
          return Promise.resolve(event);
        }
      }
      return new Promise((resolve, reject) => {
        let timeout: ReturnType<typeof setTimeout>;
        const waiter = {
          reject,
          resolve(event: DevDiagnosticEvent) {
            clearTimeout(timeout);
            resolve(event);
          },
          type,
        };
        waiters.add(waiter);
        timeout = setTimeout(() => {
          if (waiters.delete(waiter)) {
            reject(new Error(`Timed out waiting for diagnostic ${type}`));
          }
        }, DIAGNOSTIC_EVENT_TIMEOUT_MS);
      });
    },
  };
}

function healthyPage(content: string): string {
  return [
    'import { defineRoute } from "@teyik0/furin";',
    'import { route as rootRoute } from "./root";',
    "",
    "export const route = defineRoute()",
    '  .config({ layout: rootRoute, mode: "ssr" })',
    `  .page(() => <main>${content}</main>);`,
  ].join("\n");
}

function failingLoaderPage(): string {
  return [
    'import { defineRoute } from "@teyik0/furin";',
    'import { route as rootRoute } from "./root";',
    "",
    "export const route = defineRoute()",
    '  .config({ layout: rootRoute, mode: "ssr" })',
    '  .loader(() => { throw new Error("loader exploded", { cause: new Error("upstream") }); })',
    "  .page(() => <main>Unreachable loader page</main>);",
  ].join("\n");
}

function failingResponseLoaderPage(): string {
  return [
    'import { defineRoute } from "@teyik0/furin";',
    'import { route as rootRoute } from "./root";',
    "",
    "export const route = defineRoute()",
    '  .config({ layout: rootRoute, mode: "ssr" })',
    '  .loader(() => { throw new Response("response exploded", { status: 500, statusText: "Upstream" }); })',
    "  .page(() => <main>Unreachable response page</main>);",
  ].join("\n");
}

function failingRenderPage(mode: "ssg" | "ssr"): string {
  return [
    'import { defineRoute } from "@teyik0/furin";',
    'import { route as rootRoute } from "./root";',
    "",
    "export const route = defineRoute()",
    `  .config({ layout: rootRoute, mode: "${mode}" })`,
    '  .page(() => { throw new Error("render exploded"); });',
  ].join("\n");
}

function importedComponentPage(): string {
  return [
    'import { defineRoute } from "@teyik0/furin";',
    'import { BrokenCard } from "../components/broken-card";',
    'import { route as rootRoute } from "./root";',
    "",
    "export const route = defineRoute()",
    '  .config({ layout: rootRoute, mode: "ssr" })',
    "  .page(() => <BrokenCard />);",
  ].join("\n");
}

describe.serial("development diagnostics", () => {
  const app = createTmpApp("cli-app");
  let port: number;
  let server: ReturnType<typeof startProcess>;

  beforeAll(async () => {
    port = await getFreePort();
    writeAppFile(app.path, "src/pages/index.tsx", healthyPage("Healthy"));
    server = startProcess(["bun", "--hot", join(app.path, "src/server.ts")], {
      cwd: app.path,
      env: { PORT: String(port) },
    });

    for (let attempt = 0; attempt < 80; attempt += 1) {
      try {
        if ((await fetch(`http://localhost:${port}/`)).ok) {
          return;
        }
      } catch {
        // The server is still starting.
      }
      await Bun.sleep(250);
    }
    throw new Error(`Development server did not start\n${server.getStderr()}`);
  }, 30_000);

  afterAll(() => {
    server?.kill();
    app.cleanup();
  });

  test("an import failure returns an actionable application diagnostic", async () => {
    writeAppFile(
      app.path,
      "src/pages/index.tsx",
      `${healthyPage("Unreachable")}\nthrow new Error("module exploded");`
    );

    let response: Response | undefined;
    let html = "";
    for (let attempt = 0; attempt < 40; attempt += 1) {
      response = await fetch(`http://localhost:${port}/`);
      html = await response.text();
      if (response.status === 500 && html.includes("__FURIN_DEV_DIAGNOSTIC__")) {
        break;
      }
      await Bun.sleep(250);
    }

    expect(response?.status).toBe(500);
    const stateMatch = DIAGNOSTIC_STATE_RE.exec(html);
    expect(stateMatch?.[1]).toBeDefined();
    const state = JSON.parse(stateMatch?.[1] ?? "{}") as EmbeddedDiagnosticState;
    expect(state.event.version).toBe(1);
    expect(state.event.type).toBe("error");
    expect(state.event.diagnostic.phase).toBe("import");
    expect(state.event.diagnostic.route).toBe("/");
    expect(state.event.diagnostic.location?.file).toContain("src/pages/index.tsx");
    expect(state.event.diagnostic.message).toBe("module exploded");
    expect(html).toContain("/_furin/dev/overlay.js");
  }, 20_000);

  test("the browser event socket replays the active diagnostic", async () => {
    const events = await openDiagnosticSocket(port);
    const event = await events.next("error");
    events.close();

    if (event.type !== "error") {
      throw new Error(`Expected an error diagnostic, received ${event.type}`);
    }
    expect(event.diagnostic.message).toBe("module exploded");

    const removedStream = await fetch(`http://localhost:${port}/_furin/dev/events`);
    expect(removedStream.status).toBe(404);
  }, 20_000);

  test("a successful revision clears the cold error without restarting the server", async () => {
    writeAppFile(app.path, "src/pages/index.tsx", healthyPage("Recovery baseline"));
    let baselineHtml = "";
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const response = await fetch(`http://localhost:${port}/`);
      baselineHtml = await response.text();
      if (response.ok && baselineHtml.includes("Recovery baseline")) {
        break;
      }
      await Bun.sleep(250);
    }
    expect(baselineHtml).toContain("Recovery baseline");

    const events = await openDiagnosticSocket(port);
    writeAppFile(
      app.path,
      "src/pages/index.tsx",
      `${healthyPage("Unreachable recovery")}
throw new Error("recovery exploded");`
    );
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const response = await fetch(`http://localhost:${port}/`);
      if (response.status === 500) {
        break;
      }
      await Bun.sleep(250);
    }
    const errorEvent = await events.next("error");
    if (errorEvent.type !== "error") {
      throw new Error(`Expected an error diagnostic, received ${errorEvent.type}`);
    }
    expect(errorEvent.diagnostic.message).toBe("recovery exploded");
    const readyEvent = events.next("ready");

    writeAppFile(app.path, "src/pages/index.tsx", healthyPage("Healthy again"));
    let html = "";
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const response = await fetch(`http://localhost:${port}/`);
      html = await response.text();
      if (response.ok && html.includes("Healthy again")) {
        break;
      }
      await Bun.sleep(250);
    }
    expect(html).toContain("Healthy again");

    expect((await readyEvent).type).toBe("ready");
    events.close();
  }, 30_000);

  test("accepts a browser render diagnostic from the overlay client", async () => {
    const componentPath = join(app.path, "src/components/client-card.tsx");
    writeAppFile(
      app.path,
      "src/components/client-card.tsx",
      "export function ClientCard() { return <aside>Client card</aside>; }"
    );
    writeAppFile(
      app.path,
      "src/pages/index.tsx",
      [
        'import { defineRoute } from "@teyik0/furin";',
        'import { ClientCard } from "../components/client-card.tsx";',
        'import { route as rootRoute } from "./root";',
        "export const route = defineRoute()",
        '  .config({ layout: rootRoute, mode: "ssr" })',
        "  .page(() => <ClientCard />);",
      ].join("\n")
    );
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const page = await fetch(`http://localhost:${port}/`);
      if (page.ok && (await page.text()).includes("Client card")) {
        break;
      }
      await Bun.sleep(250);
    }
    const response = await fetch(`http://localhost:${port}/_furin/dev/client-errors`, {
      body: JSON.stringify({
        message: "client render exploded",
        phase: "client-render",
        route: "/",
        stack: `Error: client render exploded\n    at ClientCard (${pathToFileURL(realpathSync(componentPath)).href}:1:1)`,
      }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });

    expect(response.status).toBe(200);
    const event = (await response.json()) as EmbeddedDiagnosticState["event"];
    expect(event.type).toBe("error");
    expect(event.diagnostic.phase).toBe("client-render");
    expect(event.diagnostic.message).toBe("client render exploded");
    expect(event.diagnostic.importChain[0]).toContain("src/pages/index.tsx");
    expect(event.diagnostic.importChain[1]).toContain("src/components/client-card.tsx");
  }, 20_000);

  test("normalizes client diagnostic paths to dynamic route patterns", async () => {
    const pagePath = join(app.path, "src/pages/blog/[slug].tsx");
    writeAppFile(
      app.path,
      "src/pages/blog/[slug].tsx",
      [
        'import { defineRoute } from "@teyik0/furin";',
        'import { route as rootRoute } from "../root";',
        "export const route = defineRoute()",
        '  .config({ layout: rootRoute, mode: "ssr" })',
        "  .page(() => <main>Dynamic client page</main>);",
      ].join("\n")
    );
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const page = await fetch(`http://localhost:${port}/blog/post-1`);
      if (page.ok && (await page.text()).includes("Dynamic client page")) {
        break;
      }
      await Bun.sleep(250);
    }

    const response = await fetch(`http://localhost:${port}/_furin/dev/client-errors`, {
      body: JSON.stringify({
        message: "dynamic client render exploded",
        phase: "client-render",
        route: "/blog/post-1",
        stack: `Error: dynamic client render exploded\n    at Page (${pathToFileURL(realpathSync(pagePath)).href}:1:1)`,
      }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    const event = (await response.json()) as EmbeddedDiagnosticState["event"];

    expect(event.diagnostic.route).toBe("/blog/:slug");
  }, 20_000);

  test("a loader failure reports its phase and cause", async () => {
    writeAppFile(app.path, "src/pages/index.tsx", failingLoaderPage());

    let response: Response | undefined;
    let state: EmbeddedDiagnosticState | undefined;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      response = await fetch(`http://localhost:${port}/`);
      const html = await response.text();
      const stateMatch = DIAGNOSTIC_STATE_RE.exec(html);
      if (stateMatch?.[1]) {
        state = JSON.parse(stateMatch[1]) as EmbeddedDiagnosticState;
        if (state.event.diagnostic.message === "loader exploded") {
          break;
        }
      }
      await Bun.sleep(250);
    }

    expect(response?.status).toBe(500);
    expect(state?.event.diagnostic.phase).toBe("loader");
    expect(state?.event.diagnostic.message).toBe("loader exploded");
    expect(state?.event.diagnostic.cause).toBe("upstream");
  }, 20_000);

  test("a thrown loader response reports its public message and status cause", async () => {
    writeAppFile(app.path, "src/pages/index.tsx", failingResponseLoaderPage());

    let state: EmbeddedDiagnosticState | undefined;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const html = await (await fetch(`http://localhost:${port}/`)).text();
      const stateMatch = DIAGNOSTIC_STATE_RE.exec(html);
      if (stateMatch?.[1]) {
        state = JSON.parse(stateMatch[1]) as EmbeddedDiagnosticState;
        if (state.event.diagnostic.message === "response exploded") {
          break;
        }
      }
      await Bun.sleep(250);
    }

    expect(state?.event.diagnostic.phase).toBe("loader");
    expect(state?.event.diagnostic.message).toBe("response exploded");
    expect(state?.event.diagnostic.cause).toBe("500 Upstream");
  }, 20_000);

  test("a server render failure reports the render phase", async () => {
    writeAppFile(app.path, "src/pages/index.tsx", failingRenderPage("ssr"));

    let response: Response | undefined;
    let state: EmbeddedDiagnosticState | undefined;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      response = await fetch(`http://localhost:${port}/`);
      const html = await response.text();
      const stateMatch = DIAGNOSTIC_STATE_RE.exec(html);
      if (stateMatch?.[1]) {
        state = JSON.parse(stateMatch[1]) as EmbeddedDiagnosticState;
        if (state.event.diagnostic.message === "render exploded") {
          break;
        }
      }
      await Bun.sleep(250);
    }

    expect(response?.status).toBe(500);
    expect(state?.event.diagnostic.phase).toBe("render");
    expect(state?.event.diagnostic.message).toBe("render exploded");
    expect(state?.event.diagnostic.location?.file).toContain("src/pages/index.tsx");
  }, 20_000);

  test("an SSG render failure is classified as render rather than import", async () => {
    writeAppFile(app.path, "src/pages/index.tsx", failingRenderPage("ssg"));

    let state: EmbeddedDiagnosticState | undefined;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const html = await (await fetch(`http://localhost:${port}/`)).text();
      const stateMatch = DIAGNOSTIC_STATE_RE.exec(html);
      if (stateMatch?.[1]) {
        state = JSON.parse(stateMatch[1]) as EmbeddedDiagnosticState;
        if (state.event.diagnostic.message === "render exploded") {
          break;
        }
      }
      await Bun.sleep(250);
    }

    expect(state?.event.diagnostic.phase).toBe("render");
  }, 20_000);

  test("an imported module failure includes its application import chain", async () => {
    writeAppFile(
      app.path,
      "src/components/broken-card.tsx",
      'throw new Error("component module exploded");\nexport function BrokenCard() { return <aside />; }'
    );
    writeAppFile(app.path, "src/pages/index.tsx", importedComponentPage());

    let state: EmbeddedDiagnosticState | undefined;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const html = await (await fetch(`http://localhost:${port}/`)).text();
      const stateMatch = DIAGNOSTIC_STATE_RE.exec(html);
      if (stateMatch?.[1]) {
        state = JSON.parse(stateMatch[1]) as EmbeddedDiagnosticState;
        if (state.event.diagnostic.message === "component module exploded") {
          break;
        }
      }
      await Bun.sleep(250);
    }

    expect(state?.event.diagnostic.location?.file).toContain("src/components/broken-card.tsx");
    expect(state?.event.diagnostic.importChain).toHaveLength(2);
    expect(state?.event.diagnostic.importChain[0]).toContain("src/pages/index.tsx");
    expect(state?.event.diagnostic.importChain[1]).toContain("src/components/broken-card.tsx");
  }, 20_000);

  test("a syntax failure is classified as a transform diagnostic", async () => {
    writeAppFile(
      app.path,
      "src/pages/index.tsx",
      `${healthyPage("Unreachable")}\nconst invalid = ;`
    );

    let state: EmbeddedDiagnosticState | undefined;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const html = await (await fetch(`http://localhost:${port}/`)).text();
      const stateMatch = DIAGNOSTIC_STATE_RE.exec(html);
      if (stateMatch?.[1]) {
        state = JSON.parse(stateMatch[1]) as EmbeddedDiagnosticState;
        if (
          state.event.diagnostic.phase === "transform" &&
          !state.event.diagnostic.message.includes("valid Furin page export")
        ) {
          break;
        }
      }
      await Bun.sleep(250);
    }

    expect(state?.event.diagnostic.phase).toBe("transform");
    expect(state?.event.diagnostic.location?.file).toContain("src/pages/index.tsx");
  }, 20_000);

  test("an invalid page export is routed through the diagnostic overlay", async () => {
    writeAppFile(
      app.path,
      "src/pages/index.tsx",
      [
        'import { defineRoute } from "@teyik0/furin";',
        'import { route as rootRoute } from "./root";',
        "",
        "export const route = defineRoute()",
        '  .config({ layout: rootRoute, mode: "ssr" })',
        "  .loader(() => ({}));",
      ].join("\n")
    );

    let state: EmbeddedDiagnosticState | undefined;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const html = await (await fetch(`http://localhost:${port}/`)).text();
      const stateMatch = DIAGNOSTIC_STATE_RE.exec(html);
      if (stateMatch?.[1]) {
        state = JSON.parse(stateMatch[1]) as EmbeddedDiagnosticState;
        if (state.event.diagnostic.message.includes("valid Furin page export")) {
          break;
        }
      }
      await Bun.sleep(250);
    }

    expect(state?.event.diagnostic.phase).toBe("transform");
    expect(state?.event.diagnostic.message).toContain("valid Furin page export");
    expect(state?.event.diagnostic.location?.file).toContain("src/pages/index.tsx");
  }, 20_000);
});

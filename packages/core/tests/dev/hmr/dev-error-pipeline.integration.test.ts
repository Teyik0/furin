// biome-ignore-all lint/performance/noAwaitInLoops: integration test polling must wait between retries
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import type { DevGraphEvent } from "../../../src/server/dev/graph.ts";
import { createTmpApp, writeAppFile } from "../../support/app-fixtures.ts";
import { getFreePort } from "../../support/hmr.ts";
import { startProcess } from "../../support/process.ts";

interface EmbeddedErrorState {
  basePath: string;
  event: Extract<DevGraphEvent, { type: "error" }>;
}

const DEV_ERROR_STATE_RE =
  /<script id="__FURIN_DEV_ERROR__" type="application\/json">(.+?)<\/script>/;

function pageSource(content: string): string {
  return [
    'import { defineRoute } from "@teyik0/furin";',
    'import { route as rootRoute } from "./root";',
    "",
    "export const route = defineRoute()",
    '  .config({ layout: rootRoute, mode: "ssr" })',
    `  .page(() => <main>${content}</main>);`,
  ].join("\n");
}

function moduleFailureSource(): string {
  return `${pageSource("Unreachable")}\nthrow new Error("module exploded");`;
}

function failingLoaderSource(): string {
  return [
    'import { defineRoute } from "@teyik0/furin";',
    'import { route as rootRoute } from "./root";',
    "",
    "export const route = defineRoute()",
    '  .config({ layout: rootRoute, mode: "ssr" })',
    '  .loader(() => { throw new Error("loader exploded", { cause: new Error("upstream") }); })',
    "  .page(() => <main>Loader failure</main>);",
  ].join("\n");
}

function failingRenderSource(): string {
  return [
    'import { defineRoute } from "@teyik0/furin";',
    'import { route as rootRoute } from "./root";',
    "",
    "export const route = defineRoute()",
    '  .config({ layout: rootRoute, mode: "ssr" })',
    '  .page(() => { throw new Error("render exploded"); });',
  ].join("\n");
}

function importedComponentPageSource(): string {
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

function waitForSocketEvent(
  socket: WebSocket,
  predicate: (event: DevGraphEvent) => boolean
): Promise<DevGraphEvent> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      socket.close();
      reject(new Error("Timed out waiting for a matching dev graph event"));
    }, 10_000);
    const onMessage = (message: MessageEvent): void => {
      const event = JSON.parse(String(message.data)) as DevGraphEvent;
      if (!predicate(event)) {
        return;
      }
      clearTimeout(timeout);
      socket.removeEventListener("message", onMessage);
      resolve(event);
    };
    socket.addEventListener("message", onMessage);
  });
}

describe.serial("dev error pipeline", () => {
  const app = createTmpApp("cli-app");
  let port: number;
  let server: ReturnType<typeof startProcess>;

  beforeAll(async () => {
    port = await getFreePort();
    writeAppFile(app.path, "src/pages/index.tsx", pageSource("Healthy"));
    server = startProcess(["bun", "--hot", join(app.path, "src/server.ts")], {
      cwd: app.path,
      env: { PORT: String(port) },
    });
    for (let attempt = 0; attempt < 80; attempt += 1) {
      try {
        const response = await fetch(`http://localhost:${port}/`);
        if (response.ok) {
          return;
        }
      } catch {
        // Server is still starting.
      }
      await Bun.sleep(250);
    }
    throw new Error(
      `Dev error pipeline test server did not start\n${server.getStdout()}\n${server.getStderr()}`
    );
  }, 30_000);

  afterAll(() => {
    server?.kill();
    app.cleanup();
  });

  test("an import failure reaches the overlay and a successful revision recovers the route", async () => {
    writeAppFile(app.path, "src/pages/index.tsx", moduleFailureSource());

    let response: Response | undefined;
    let html = "";
    for (let attempt = 0; attempt < 40; attempt += 1) {
      response = await fetch(`http://localhost:${port}/`);
      html = await response.text();
      if (response.status === 500 && html.includes("__FURIN_DEV_ERROR__")) {
        break;
      }
      await Bun.sleep(250);
    }

    expect(response?.status).toBe(500);
    const stateMatch = DEV_ERROR_STATE_RE.exec(html);
    expect(stateMatch?.[1]).toBeDefined();
    const state = JSON.parse(stateMatch?.[1] ?? "{}") as EmbeddedErrorState;
    expect(state.event.error.phase).toBe("import");
    expect(state.event.error.route).toBe("/");
    expect(state.event.error.file).toContain("src/pages/index.tsx");
    expect(state.event.error.line).toBeNumber();
    expect(html).toContain("/_furin/dev/error-overlay.js");

    const socket = new WebSocket(
      `ws://localhost:${port}/_furin/dev/errors?after=${state.event.id}`
    );
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener("open", () => resolve(), { once: true });
      socket.addEventListener("error", () => reject(new Error("WebSocket failed")), {
        once: true,
      });
    });
    const ready = waitForSocketEvent(
      socket,
      (event) => event.type === "ready" && event.revision > state.event.revision
    );
    writeAppFile(app.path, "src/pages/index.tsx", pageSource("Healthy again"));
    await ready;
    socket.close();

    let recovered = "";
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const recoveredResponse = await fetch(`http://localhost:${port}/`);
      recovered = await recoveredResponse.text();
      if (recoveredResponse.ok && recovered.includes("Healthy again")) {
        break;
      }
      await Bun.sleep(250);
    }
    expect(recovered).toContain("Healthy again");

    writeAppFile(app.path, "src/pages/index.tsx", failingLoaderSource());
    const loaderResponse = await fetch(`http://localhost:${port}/`);
    const loaderHtml = await loaderResponse.text();
    const loaderStateMatch = DEV_ERROR_STATE_RE.exec(loaderHtml);
    const loaderState = JSON.parse(loaderStateMatch?.[1] ?? "{}") as EmbeddedErrorState;
    expect(loaderResponse.status).toBe(500);
    expect(loaderState.event.error.phase).toBe("loader");
    expect(loaderState.event.error.message).toBe("loader exploded");
    expect(loaderState.event.error.cause).toBe("upstream");

    writeAppFile(app.path, "src/pages/index.tsx", failingRenderSource());
    const renderResponse = await fetch(`http://localhost:${port}/`);
    const renderHtml = await renderResponse.text();
    const renderStateMatch = DEV_ERROR_STATE_RE.exec(renderHtml);
    const renderState = JSON.parse(renderStateMatch?.[1] ?? "{}") as EmbeddedErrorState;
    expect(renderResponse.status).toBe(500);
    expect(renderState.event.error.phase).toBe("render");
    expect(renderState.event.error.message).toBe("render exploded");

    writeAppFile(
      app.path,
      "src/components/broken-card.tsx",
      'throw new Error("component module exploded");\nexport function BrokenCard() { return <aside />; }'
    );
    writeAppFile(app.path, "src/pages/index.tsx", importedComponentPageSource());
    const importResponse = await fetch(`http://localhost:${port}/`);
    const importHtml = await importResponse.text();
    const importStateMatch = DEV_ERROR_STATE_RE.exec(importHtml);
    const importState = JSON.parse(importStateMatch?.[1] ?? "{}") as EmbeddedErrorState;
    expect(importResponse.status).toBe(500);
    expect(importState.event.error.phase).toBe("import");
    expect(importState.event.error.file).toContain("src/components/broken-card.tsx");
    expect(importState.event.error.importChain).toHaveLength(2);
    expect(importState.event.error.importChain[0]).toContain("src/pages/index.tsx");
    expect(importState.event.error.importChain[1]).toContain("src/components/broken-card.tsx");
  }, 30_000);
});

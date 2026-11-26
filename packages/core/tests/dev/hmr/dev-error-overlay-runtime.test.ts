import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { Elysia } from "elysia";
import { createDevDiagnostic, DevDiagnosticStore } from "../../../src/server/dev/diagnostics.ts";
import { createDevDiagnosticPlugin } from "../../../src/server/dev/plugin.ts";
import type { BrowserEventFor } from "../../../src/shared/browser-events.ts";
import { installDom, uninstallDom } from "../../support/dom.ts";

afterEach(async () => {
  mock.restore();
  await uninstallDom();
});

async function loadOverlay(
  report: (input: string, init: RequestInit | undefined) => Promise<Response>
) {
  installDom();
  const app = new Elysia().use(
    createDevDiagnosticPlugin(new DevDiagnosticStore(), undefined, undefined)
  );
  const response = await app.handle(new Request("http://localhost:3000/_furin/dev/overlay.js"));
  const source = (await response.text()).replace(
    "import.meta.url",
    JSON.stringify("http://localhost:3000/_furin/dev/overlay.js")
  );
  const reload = spyOn(window.location, "reload").mockImplementation(() => undefined);
  new Function("window", "document", "fetch", source)(window, document, report);
  return reload;
}

test("a client render failure retries once after the next applied update, even before reporting finishes", async () => {
  const reload = await loadOverlay(() => new Promise<Response>(() => undefined));

  window.dispatchEvent(new Event("furin:hmr-before-update"));
  window.dispatchEvent(new Event("furin:hmr-after-update"));
  expect(reload).not.toHaveBeenCalled();

  window.dispatchEvent(new Event("furin:hmr-before-update"));
  window.dispatchEvent(
    new CustomEvent("furin:client-error", {
      detail: { error: new Error("render exploded"), phase: "client-render" },
    })
  );
  window.dispatchEvent(new Event("furin:hmr-after-update"));
  expect(reload).not.toHaveBeenCalled();

  window.dispatchEvent(new Event("furin:hmr-before-update"));
  expect(reload).not.toHaveBeenCalled();
  window.dispatchEvent(new Event("furin:hmr-after-update"));
  window.dispatchEvent(new Event("furin:hmr-after-update"));
  expect(reload).toHaveBeenCalledTimes(1);
});

test("server readiness cannot prevent recovery of a failed client render", async () => {
  installDom();
  let onDiagnostic: ((event: BrowserEventFor<"diagnostic">) => void) | undefined;
  Object.assign(window, {
    [Symbol.for("furin.browser-events.runtime")]: {
      subscribe: (
        _channel: "diagnostic",
        listener: (event: BrowserEventFor<"diagnostic">) => void
      ) => {
        onDiagnostic = listener;
        return () => undefined;
      },
    },
  });
  const event = new DevDiagnosticStore().publish(
    createDevDiagnostic(new Error("render exploded"), {
      entryPath: "/src/card.tsx",
      importChain: [],
      phase: "client-render",
      route: "/",
    })
  );
  const reload = await loadOverlay(() => Promise.resolve(Response.json(event)));
  window.dispatchEvent(
    new CustomEvent("furin:client-error", {
      detail: { error: new Error("render exploded"), phase: "client-render" },
    })
  );
  await Bun.sleep(0);
  expect(document.querySelector("#__furin-dev-error-overlay")).not.toBeNull();

  onDiagnostic?.({
    channel: "diagnostic",
    data: {
      id: event.id + 1,
      revision: event.revision + 1,
      serverId: event.serverId,
      type: "ready",
      version: event.version,
    },
    version: 1,
  });
  expect(document.querySelector("#__furin-dev-error-overlay")).toBeNull();
  expect(reload).not.toHaveBeenCalled();
  window.dispatchEvent(new Event("furin:hmr-before-update"));
  window.dispatchEvent(new Event("furin:hmr-after-update"));
  expect(reload).toHaveBeenCalledTimes(1);
});

test("hot WebKit blob frames use the real source map directive when reporting errors", async () => {
  let reportedStack: string | undefined;
  await loadOverlay((url, init) => {
    if (url === "blob:http://localhost:3000/update") {
      return Promise.resolve(
        new Response(
          "const code = `\n//# sourceMappingURL=` + sourceMap;\n//# sourceMappingURL=/_bun/client/actual.js.map\n"
        )
      );
    }
    reportedStack = (JSON.parse(String(init?.body)) as { stack: string }).stack;
    return Promise.resolve(new Response(null, { status: 400 }));
  });
  const error = new Error("hot render exploded");
  error.stack = "after@blob:http://localhost:3000/update:1:1";
  window.dispatchEvent(
    new CustomEvent("furin:client-error", { detail: { error, phase: "client-render" } })
  );
  await Bun.sleep(0);

  expect(reportedStack).toBe("after@http://localhost:3000/_bun/client/actual.js.map:1:1");
});

function declareEntry(): void {
  const entry = document.createElement("script");
  entry.setAttribute("data-furin-entry", "");
  entry.setAttribute("src", "/_bun/client/index.js");
  document.head.append(entry);
}

test("an uncaught error in the hydrate entry before hydration reaches the overlay", async () => {
  let reported: { message: string; phase: string } | undefined;
  await loadOverlay((_url, init) => {
    reported = JSON.parse(String(init?.body)) as { message: string; phase: string };
    return Promise.resolve(new Response(null, { status: 400 }));
  });
  declareEntry();

  window.dispatchEvent(
    new ErrorEvent("error", {
      error: new SyntaxError("Cannot declare a var variable that shadows a let/const"),
      filename: "http://localhost:3000/_bun/client/index.js",
      message: "SyntaxError: Cannot declare a var variable that shadows a let/const",
    })
  );
  await Bun.sleep(0);

  expect(reported).toMatchObject({
    message: "Cannot declare a var variable that shadows a let/const",
    phase: "hydrate",
  });
});

test("uncaught errors outside the hydrate entry or after the root mounts are not hydrate failures", async () => {
  const report = mock(() => Promise.resolve(new Response(null, { status: 400 })));
  await loadOverlay(report);
  declareEntry();
  const uncaught = (filename: string) =>
    window.dispatchEvent(
      new ErrorEvent("error", { error: new Error("boom"), filename, message: "boom" })
    );

  uncaught("chrome-extension://wallet/inpage.js");
  uncaught("http://localhost:3000/analytics.js");
  uncaught("not a url");
  Object.assign(window, { __FURIN_ROOT__: {} });
  uncaught("http://localhost:3000/_bun/client/index.js");
  await Bun.sleep(0);

  expect(report).not.toHaveBeenCalled();
});

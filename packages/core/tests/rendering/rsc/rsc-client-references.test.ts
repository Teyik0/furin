import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { buildClient } from "../../../src/build/client.ts";
import {
  clientModuleId,
  clientReferencesPlugin,
} from "../../../src/rsc/build/client-references.ts";
import { flightLoaderPlugin } from "../../../src/rsc/build/flight-loader.ts";
import { buildRscGraph } from "../../../src/rsc/build/index.ts";
import { createTmpApp, writeAppFile } from "../../support/app-fixtures.ts";
import { getTestPort, waitForHttp } from "../../support/http.ts";
import { startProcess } from "../../support/process.ts";

const temporaryDirectory = join(import.meta.dir, "../../../.tmp-tests");
mkdirSync(temporaryDirectory, { recursive: true });

test("client references share their identity across Windows and browser import paths", () => {
  expect(clientModuleId("D:\\apps\\src\\counter.tsx")).toBe(
    clientModuleId("D:/apps/src/counter.tsx")
  );
});

test.each(["loader", "layout"])(
  "client boundary discovery preserves tree shaking for %s imports",
  async (mode) => {
    const directory = mkdtempSync(join(temporaryDirectory, "rsc-references-"));
    try {
      await Bun.write(
        join(directory, "dependency.ts"),
        `"use client";
export function label() { return "Count"; }
export function unused() { return "UNUSED_CLIENT_BOUNDARY_EXPORT"; }`
      );
      await Bun.write(
        join(directory, "counter.tsx"),
        `"use client";
import { label } from "./dependency";
export default function Counter() { return <button>{label()}</button>; }
export function Unused() { return <span>UNUSED_ROOT_CLIENT_BOUNDARY_EXPORT</span>; }`
      );
      const root = join(directory, "root.tsx");
      await Bun.write(
        root,
        `import { defineRootRoute, HeadContent, Scripts } from "@teyik0/furin";
import { CompositeComponent, createCompositeComponent } from "@teyik0/furin/rsc";
import Counter from "./counter";
export const route = defineRootRoute()
${mode === "loader" ? ".loader(async () => ({ tree: await createCompositeComponent(() => <Counter />) }))" : ""}
.layout(({ children${mode === "loader" ? ", tree" : ""} }) => <html><head><HeadContent /></head><body>${mode === "loader" ? "<CompositeComponent src={tree} />" : "<Counter />"}{children}<Scripts /></body></html>);`
      );
      await buildClient([], {
        outDir: join(directory, "output"),
        basePath: "",
        clientLogging: false,
        publicPath: "/_client/",
        rootLayout: root,
      });
      const files = await Array.fromAsync(
        new Bun.Glob("*.js").scan({ cwd: join(directory, "output/client"), absolute: true })
      );
      const code = (await Promise.all(files.map((path) => Bun.file(path).text()))).join("\n");
      expect(code.includes("UNUSED_CLIENT_BOUNDARY_EXPORT")).toBe(false);
      expect(code.includes("UNUSED_ROOT_CLIENT_BOUNDARY_EXPORT")).toBe(mode === "loader");
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  }
);

test("a use-client component renders through Flight without running its hooks in the RSC renderer", async () => {
  const directory = mkdtempSync(join(temporaryDirectory, "rsc-references-"));
  try {
    mkdirSync(join(directory, "output"));
    await Bun.write(
      join(directory, "counter.tsx"),
      `"use client";
import { useState } from "react";
export default function Counter() {
  const [count, setCount] = useState(0);
  return <button onClick={() => setCount(count + 1)}>{count}</button>;
}`
    );
    await Bun.write(
      join(directory, "entry.tsx"),
      `import { renderServerComponent } from "@teyik0/furin/rsc";
import { renderToReadableStream } from "react-dom/server";
import Counter from "./counter.tsx";
const tree = await renderServerComponent(<Counter />);
console.log(await new Response(await renderToReadableStream(tree)).text());`
    );
    const build = await Bun.build({
      entrypoints: [join(directory, "entry.tsx")],
      external: ["react", "react-dom", "react-dom/*", "@teyik0/furin/rsc"],
      outdir: join(directory, "output"),
      plugins: [clientReferencesPlugin()],
      target: "bun",
    });
    expect(build.success).toBe(true);
    const child = Bun.spawn([process.execPath, join(directory, "output/entry.js")], {
      stderr: "pipe",
      stdout: "pipe",
    });
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect(stderr).toBe("");
    expect(exitCode).toBe(0);
    expect(stdout.trim()).toBe("<button>0</button>");
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

test("the react-server graph replaces a client boundary with references and emits its manifest", async () => {
  const directory = mkdtempSync(join(temporaryDirectory, "rsc-references-"));
  try {
    await Bun.write(
      join(directory, "counter.tsx"),
      `"use client";
import { useState } from "react";
export default function Counter() {
  const [count] = useState(0);
  return <button>CLIENT_IMPLEMENTATION_MARKER {count}</button>;
}`
    );
    await Bun.write(
      join(directory, "root.tsx"),
      'import Counter from "./counter.tsx"; export const tree = <Counter />;'
    );
    const manifest = await buildRscGraph(
      [{ root: { path: join(directory, "root.tsx"), route: {} as never }, routes: [] }],
      join(directory, "output"),
      "client-reference-build",
      undefined
    );
    expect(manifest.clientReferences.some((reference) => reference.name === "default")).toBe(true);
    const files = await Array.fromAsync(
      new Bun.Glob("**/*.js").scan({ cwd: join(directory, "output/rsc"), absolute: true })
    );
    const code = (await Promise.all(files.map((path) => Bun.file(path).text()))).join("\n");
    expect(code).not.toContain("CLIENT_IMPLEMENTATION_MARKER");
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

test.each(["development", "production"])(
  "Furin renders a composite containing Link and a loader-only client component (%s)",
  async (mode) => {
    const app = createTmpApp("cli-app");
    try {
      writeAppFile(
        app.path,
        "src/counter.tsx",
        `"use client";
import { useState } from "react";
export default function Counter() {
  const [count, setCount] = useState(0);
  return <button onClick={() => setCount(count + 1)}>Count: {count}</button>;
}`
      );
      writeAppFile(
        app.path,
        "src/pages/index.tsx",
        `import { defineRoute } from "@teyik0/furin";
import { Link } from "@teyik0/furin/link";
import { CompositeComponent, createCompositeComponent } from "@teyik0/furin/rsc";
import Counter from "../counter.tsx";
export const route = defineRoute().config({ mode: "isr", revalidate: 300 })
  .loader(async () => ({ header: await createCompositeComponent(({ children }) => <header><Link to="/blog/hello">Blog</Link><Counter />{children}</header>) }))
  .page(({ header }) => <CompositeComponent src={header}><span>Client slot</span></CompositeComponent>);`
      );
      if (mode === "production") {
        const buildPath = join(import.meta.dir, "../../../src/build/index.ts");
        const child = Bun.spawn(
          [
            process.execPath,
            "-e",
            `const { buildApp } = await import(${JSON.stringify(buildPath)}); await buildApp({ rootDir: ${JSON.stringify(app.path)}, target: "bun" });`,
          ],
          { stdout: "pipe", stderr: "pipe" }
        );
        const [status, output, errors] = await Promise.all([
          child.exited,
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
        ]);
        expect({ errors, status }).toEqual({ errors: "", status: 0 });
        expect(output).toContain("Production client build complete");
      }
      const port = getTestPort();
      const server = startProcess(
        [
          process.execPath,
          join(app.path, mode === "production" ? ".furin/build/bun/server.js" : "src/server.ts"),
        ],
        { cwd: app.path, env: { NODE_ENV: mode, PORT: String(port) } }
      );
      try {
        const response = await waitForHttp(`http://localhost:${port}/`, {
          timeoutMs: 5000,
          intervalMs: 250,
        });
        const html = await response.text();
        expect(
          server
            .getStderr()
            .replace(/^Bundled page .*$/gm, "")
            .trim()
        ).toBe("");
        expect(html).toContain('href="/blog/hello"');
        expect(html).toContain("Count: ");
        expect(html).toContain("Client slot");
      } catch (error) {
        throw new Error(server.getStderr().slice(0, 6000) || String(error), { cause: error });
      } finally {
        server.kill();
        await server.exitCode;
      }
    } finally {
      app.cleanup();
    }
  },
  { timeout: 30_000 }
);

test.each(["development", "production"])(
  "a Flight-only client component hydrates and handles clicks without webpack globals (%s)",
  async (mode) => {
    const directory = mkdtempSync(join(temporaryDirectory, "rsc-references-"));
    try {
      await Bun.write(
        join(directory, "counter.tsx"),
        `"use client";
import { useState } from "react";
export default function Counter() {
  const [count, setCount] = useState(0);
  return <button onClick={() => setCount(count + 1)}>{count}</button>;
}`
      );
      await Bun.write(
        join(directory, "server.tsx"),
        `import { renderServerComponent, getRscSourceState } from "@teyik0/furin/rsc";
import { renderToReadableStream } from "react-dom/server";
import Counter from "./counter.tsx";
const tree = await renderServerComponent(<Counter />);
const html = await new Response(await renderToReadableStream(tree)).text();
console.log(JSON.stringify({ html, bytes: [...getRscSourceState(tree).bytes] }));`
      );
      const server = await Bun.build({
        define: { "process.env.NODE_ENV": JSON.stringify(mode) },
        entrypoints: [join(directory, "server.tsx")],
        external: ["react", "react-dom", "react-dom/*", "@teyik0/furin/rsc"],
        outdir: join(directory, "server"),
        plugins: [clientReferencesPlugin()],
        target: "bun",
      });
      expect(server.success).toBe(true);
      const child = Bun.spawn([process.execPath, join(directory, "server/server.js")], {
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env, NODE_ENV: mode },
      });
      const [status, payload, errors] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      expect(errors).toBe("");
      expect(status).toBe(0);
      await Bun.write(join(directory, "payload.json"), payload);
      const runtime = join(import.meta.dir, "../../../src/rsc/client-references.ts");
      await Bun.write(
        join(directory, "browser.tsx"),
        `import { hydrateRoot } from "react-dom/client";
import { restoreRscSource } from "@teyik0/furin/rsc";
import { registerClientLoader } from ${JSON.stringify(runtime)};
import payload from "./payload.json";
registerClientLoader(${JSON.stringify(clientModuleId(join(directory, "counter.tsx")))}, () => import("./counter.tsx"));
document.body.innerHTML = payload.html;
const errors = [];
hydrateRoot(document.body, restoreRscSource("renderable", new Uint8Array(payload.bytes)), { onRecoverableError: error => errors.push(String(error)) });
export { errors };`
      );
      const browser = await Bun.build({
        entrypoints: [join(directory, "browser.tsx")],
        outdir: join(directory, "browser"),
        plugins: [flightLoaderPlugin()],
        target: "browser",
        define: { "process.env.NODE_ENV": JSON.stringify(mode) },
      });
      expect(browser.logs.map((log) => log.message)).toEqual([]);
      expect(browser.success).toBe(true);
      await Bun.write(
        join(directory, "run.ts"),
        `import { installDom, waitForDom, uninstallDom } from ${JSON.stringify(join(import.meta.dir, "../../support/dom.ts"))};
installDom();
const { errors } = await import("./browser/browser.js");
await Bun.sleep(100);
document.querySelector("button").click();
await waitForDom(() => document.querySelector("button")?.textContent === "1", undefined);
console.log(JSON.stringify({ text: document.querySelector("button").textContent, errors, webpack: "__webpack_require__" in globalThis }));
await uninstallDom();`
      );
      const hydrated = Bun.spawn([process.execPath, join(directory, "run.ts")], {
        stdout: "pipe",
        stderr: "pipe",
      });
      const [browserStatus, result, browserErrors] = await Promise.all([
        hydrated.exited,
        new Response(hydrated.stdout).text(),
        new Response(hydrated.stderr).text(),
      ]);
      expect(browserErrors).toBe("");
      expect(browserStatus).toBe(0);
      expect(JSON.parse(result)).toEqual({ text: "1", errors: [], webpack: false });
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  }
);

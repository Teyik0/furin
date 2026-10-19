import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { buildClient } from "../../../src/build/client.ts";
import { generateClientReferenceEntry } from "../../../src/build/hydrate.ts";
import {
  clientModuleId,
  clientReferencesPlugin,
} from "../../../src/rsc/build/client-references.ts";
import {
  discoverClientBoundaries,
  registerServerBoundaries,
} from "../../../src/rsc/build/discover.ts";
import { flightLoaderPlugin } from "../../../src/rsc/build/flight-loader.ts";
import { buildRscGraph } from "../../../src/rsc/build/index.ts";
import { registerClientLoader, requireClientModule } from "../../../src/rsc/client-references.ts";
import { createTmpApp, writeAppFile } from "../../support/app-fixtures.ts";
import { getFreePort } from "../../support/hmr.ts";
import { waitForHttp } from "../../support/http.ts";
import { runCli, startProcess } from "../../support/process.ts";

const temporaryDirectory = join(import.meta.dir, "../../../.tmp-tests");
mkdirSync(temporaryDirectory, { recursive: true });

test("a failed Flight client import can recover on its next attempt", async () => {
  const id = `test:${crypto.randomUUID()}`;
  const module = { default: () => null };
  let attempts = 0;
  registerClientLoader(id, () => {
    attempts += 1;
    if (attempts === 1) {
      return Promise.reject(new Error("temporary import failure"));
    }
    return Promise.resolve(module);
  });
  const first = requireClientModule(id);
  expect(requireClientModule(id)).toBe(first);
  await expect(first).rejects.toThrow("temporary import failure");
  expect(await requireClientModule(id)).toBe(module);
  expect(attempts).toBe(2);
});

test("client references share their identity across Windows and browser import paths", () => {
  expect(clientModuleId("D:\\apps\\src\\counter.tsx")).toBe(
    clientModuleId("D:/apps/src/counter.tsx")
  );
});

test.each(["js", "cjs", "cts"])(
  "SSR preserves the native default of a CommonJS client module (.%s)",
  async (extension) => {
    const directory = mkdtempSync(join(temporaryDirectory, "rsc-references-"));
    try {
      await Bun.write(
        join(directory, `counter.${extension}`),
        '"use client"; import { useState } from "react"; module.exports = function Counter() { const [count] = useState(0); return "CJS_COUNTER" + count; };'
      );
      const entry = join(directory, "entry.ts");
      await Bun.write(
        entry,
        `import { createElement } from "react";
import { renderToReadableStream } from "react-dom/server";
import { renderServerComponent } from "@teyik0/furin/rsc";
import Counter from "./counter.${extension}";
const tree = await renderServerComponent(createElement(Counter));
console.log(await new Response(await renderToReadableStream(tree)).text());`
      );
      const built = await Bun.build({
        entrypoints: [entry],
        external: ["react", "react-dom", "react-dom/*", "@teyik0/furin/rsc"],
        outdir: join(directory, "output"),
        plugins: [clientReferencesPlugin()],
        target: "bun",
      });
      expect(built.success).toBe(true);
      const child = Bun.spawn([process.execPath, join(directory, "output/entry.js")], {
        stdout: "pipe",
        stderr: "pipe",
      });
      const [status, output, errors] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      expect({ status, output: output.trim(), errors }).toEqual({
        status: 0,
        output: "CJS_COUNTER0",
        errors: "",
      });
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  }
);

test.each([
  { exports: "exports.Counter = Counter;", sideEffects: false, splitting: false },
  { exports: "module.exports = { Counter };", sideEffects: false, splitting: true },
  { exports: "module.exports = { Counter };", sideEffects: true, splitting: false },
  { exports: "exports.Counter = Counter;", sideEffects: true, splitting: true },
])(
  "SSR renders a named CommonJS client export through Flight ($exports, sideEffects: $sideEffects, splitting: $splitting)",
  async ({ exports, sideEffects, splitting }) => {
    const directory = mkdtempSync(join(temporaryDirectory, "rsc-references-"));
    try {
      const clientPackage = join(directory, "node_modules/client-package");
      await Bun.write(
        join(clientPackage, "package.json"),
        JSON.stringify({ main: "counter.js", sideEffects })
      );
      await Bun.write(
        join(clientPackage, "counter.js"),
        `"use client"; import { useState } from "react"; function Counter() { const [count] = useState(0); return "CJS_NAMED" + count; } ${exports}`
      );
      const entry = join(directory, "entry.ts");
      await Bun.write(
        entry,
        `import { createElement } from "react";
import { renderToReadableStream } from "react-dom/server";
import { renderServerComponent } from "@teyik0/furin/rsc";
import { Counter } from "client-package";
const tree = await renderServerComponent(createElement(Counter));
console.log(await new Response(await renderToReadableStream(tree)).text());`
      );
      const built = await Bun.build({
        entrypoints: [entry],
        external: ["react", "react-dom", "react-dom/*", "@teyik0/furin/rsc"],
        outdir: join(directory, "output"),
        plugins: [clientReferencesPlugin()],
        splitting,
        target: "bun",
      });
      expect(built.success).toBe(true);
      const child = Bun.spawn([process.execPath, join(directory, "output/entry.js")], {
        stdout: "pipe",
        stderr: "pipe",
      });
      const [status, output, errors] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      expect({ status, output: output.trim(), errors }).toEqual({
        status: 0,
        output: "CJS_NAMED0",
        errors: "",
      });
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  }
);

test.each([
  'export { default as Counter } from "./counter.ts";',
  'import Original from "./counter.ts"; export const Counter = Object.assign(Original, {});',
  'import Original from "./counter.ts"; export const Counter = true ? Original : () => null;',
  'import * as Original from "./counter.ts"; const { default: Counter } = Original; export { Counter };',
  'exports.Counter = require("./counter.ts").default;',
])(
  "client boundary discovery includes the canonical module of a shared reexport: %s",
  async (reexport) => {
    const directory = mkdtempSync(join(temporaryDirectory, "rsc-references-"));
    try {
      const counter = join(directory, "counter.ts");
      const barrel = join(directory, "barrel.ts");
      const direct = join(directory, "direct.ts");
      const indirect = join(directory, "indirect.ts");
      await Bun.write(counter, '"use client"; export default function Counter() { return null; }');
      await Bun.write(barrel, `"use client"; ${reexport}`);
      await Bun.write(
        direct,
        'import Counter from "./counter.ts"; export const component = Counter;'
      );
      await Bun.write(
        indirect,
        'import { Counter } from "./barrel.ts"; export const component = Counter;'
      );
      const first = await discoverClientBoundaries([direct], undefined);
      await registerServerBoundaries(first);
      const second = await discoverClientBoundaries([indirect], undefined);
      await registerServerBoundaries(second);
      expect(second.map(({ id }) => id)).toContain(clientModuleId(counter));
      expect(second.map(({ id }) => id)).toContain(clientModuleId(barrel));
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  }
);

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

test("memo, forwardRef and lazy client components render through Flight and direct SSR", async () => {
  const directory = mkdtempSync(join(temporaryDirectory, "rsc-references-"));
  try {
    await Bun.write(
      join(directory, "label.tsx"),
      `import { useState } from "react";
export default function Label({ text }: { text: string }) { const [count] = useState(0); return <u>{text + count}</u>; }`
    );
    await Bun.write(
      join(directory, "components.tsx"),
      `"use client";
import { forwardRef, lazy, memo, useState } from "react";
export const Memo = memo(function Memo({ text }: { text: string }) { const [count] = useState(1); return <b>{text + count}</b>; });
export const Forward = forwardRef<HTMLElement, { text: string }>(function Forward({ text }, ref) { const [count] = useState(2); return <i ref={ref}>{text + count}</i>; });
export const MemoForward = memo(Forward);
export const Lazy = lazy(() => import("./label.tsx"));`
    );
    await Bun.write(
      join(directory, "entry.tsx"),
      `import { renderServerComponent } from "@teyik0/furin/rsc";
import { renderToReadableStream } from "react-dom/server";
import { Forward, Lazy, Memo, MemoForward } from "./components.tsx";
const page = <><Memo text="m" /><Forward text="f" /><MemoForward text="mf" /><Lazy text="l" /></>;
const tree = await renderServerComponent(page);
console.log(await new Response(await renderToReadableStream(tree)).text());
console.log(await new Response(await renderToReadableStream(page)).text());`
    );
    const build = await Bun.build({
      entrypoints: [join(directory, "entry.tsx")],
      external: ["react", "react-dom", "react-dom/*", "@teyik0/furin/rsc"],
      outdir: join(directory, "output"),
      plugins: [clientReferencesPlugin()],
      splitting: true,
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
    const html = "<b>m1</b><i>f2</i><i>mf2</i><u>l0</u>";
    expect({ exitCode, stdout: stdout.trim(), stderr }).toEqual({
      exitCode: 0,
      stdout: `${html}\n${html}`,
      stderr: "",
    });
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

test("a Flight render leaves the client module's components unchanged", async () => {
  const directory = mkdtempSync(join(temporaryDirectory, "rsc-references-"));
  try {
    await Bun.write(
      join(directory, "label.tsx"),
      "export default function Label() { return <u>l</u>; }"
    );
    await Bun.write(
      join(directory, "components.tsx"),
      `"use client";
import { forwardRef, lazy, memo } from "react";
export function Plain() { return <s>p</s>; }
function MemoImplementation() { return <b>m</b>; }
function forwardRender(_props: object, ref: unknown) { return <i ref={ref as never}>f</i>; }
export const Memo = memo(MemoImplementation);
export const Forward = forwardRef(forwardRender);
export const Lazy = lazy(() => import("./label.tsx"));
export const original = { forwardRender, lazyInit: Lazy._init, MemoImplementation, Plain };`
    );
    await Bun.write(
      join(directory, "entry.tsx"),
      `import { renderServerComponent } from "@teyik0/furin/rsc";
import { renderToReadableStream } from "react-dom/server";
import { Forward, Lazy, Memo, original, Plain } from "./components.tsx";
const tree = await renderServerComponent(<><Plain /><Memo /><Forward /><Lazy /></>);
const html = await new Response(await renderToReadableStream(tree)).text();
console.log(JSON.stringify({
  html,
  plain: Plain === original.Plain,
  plainOwnKeys: Reflect.ownKeys(Plain).filter((key) => String(key).startsWith("$$")),
  memoType: Memo.type === original.MemoImplementation,
  forwardRender: Forward.render === original.forwardRender,
  lazyInit: Lazy._init === original.lazyInit,
  objectOwnKeys: [Memo, Forward, Lazy].flatMap((value) => Reflect.ownKeys(value).filter((key) => key === "$$id")),
}));`
    );
    const build = await Bun.build({
      entrypoints: [join(directory, "entry.tsx")],
      external: ["react", "react-dom", "react-dom/*", "@teyik0/furin/rsc"],
      outdir: join(directory, "output"),
      plugins: [clientReferencesPlugin()],
      splitting: true,
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
    expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" });
    expect(JSON.parse(stdout)).toEqual({
      html: "<s>p</s><b>m</b><i>f</i><u>l</u>",
      plain: true,
      plainOwnKeys: [],
      memoType: true,
      forwardRender: true,
      lazyInit: true,
      objectOwnKeys: [],
    });
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

test("a client module imported while Flight renders an async server component renders as a client reference", async () => {
  const directory = mkdtempSync(join(temporaryDirectory, "rsc-references-"));
  try {
    await Bun.write(
      join(directory, "counter.tsx"),
      `"use client";
import { useState } from "react";
export function Counter() { const [count] = useState(0); return <b>{count}</b>; }`
    );
    await Bun.write(
      join(directory, "entry.tsx"),
      `import { CompositeComponent, createCompositeComponent } from "@teyik0/furin/rsc";
import { renderToReadableStream } from "react-dom/server";
const tree = await createCompositeComponent(async () => {
  const { Counter } = await import("./counter.tsx");
  return <Counter />;
});
console.log(await new Response(await renderToReadableStream(<CompositeComponent src={tree} />)).text());`
    );
    const build = await Bun.build({
      entrypoints: [join(directory, "entry.tsx")],
      external: ["react", "react-dom", "react-dom/*", "@teyik0/furin/rsc"],
      outdir: join(directory, "output"),
      plugins: [clientReferencesPlugin()],
      splitting: true,
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
    expect({ exitCode, stdout: stdout.trim(), stderr }).toEqual({
      exitCode: 0,
      stdout: "<b>0</b>",
      stderr: "",
    });
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

test("SSR registration does not collide with client module bindings", async () => {
  const directory = mkdtempSync(join(temporaryDirectory, "rsc-references-"));
  try {
    await Bun.write(
      join(directory, "counter.tsx"),
      `"use client";
import { useState } from "react";
const __furinImplementation = "implementation";
function __furinRegisterClientModule() { return "register"; }
export function Counter() { const [count] = useState(0); return <b>{__furinImplementation + __furinRegisterClientModule() + count}</b>; }`
    );
    await Bun.write(
      join(directory, "entry.tsx"),
      `import { renderServerComponent } from "@teyik0/furin/rsc";
import { renderToReadableStream } from "react-dom/server";
import { Counter } from "./counter.tsx";
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
    expect(build.logs).toEqual([]);
    const child = Bun.spawn([process.execPath, join(directory, "output/entry.js")], {
      stderr: "pipe",
      stdout: "pipe",
    });
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect({ exitCode, stdout: stdout.trim(), stderr }).toEqual({
      exitCode: 0,
      stdout: "<b>implementationregister0</b>",
      stderr: "",
    });
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

test("SSR registers a client reexport whose source module is evaluated first in a cycle", async () => {
  const directory = mkdtempSync(join(temporaryDirectory, "rsc-references-"));
  try {
    await Bun.write(
      join(directory, "counter.tsx"),
      `import { Component, useState } from "react";
import { suffix } from "./boundary.tsx";
export const Counter = () => { const [count] = useState(0); return <b>{count + suffix}</b>; };
export class Title extends Component { render() { return <i>{suffix}</i>; } }`
    );
    await Bun.write(
      join(directory, "boundary.tsx"),
      `"use client";
export { Counter, Title } from "./counter.tsx";
export const suffix = "!";`
    );
    await Bun.write(
      join(directory, "entry.tsx"),
      `import "./counter.tsx";
import { renderServerComponent } from "@teyik0/furin/rsc";
import { renderToReadableStream } from "react-dom/server";
import { Counter, Title } from "./boundary.tsx";
const tree = await renderServerComponent(<><Counter /><Title /></>);
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
    expect({ exitCode, stdout: stdout.trim(), stderr }).toEqual({
      exitCode: 0,
      stdout: "<b>0!</b><i>!</i>",
      stderr: "",
    });
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

test.each([{ splitting: false }, { splitting: true }])(
  "a side-effect-free client package renders through Flight (splitting: $splitting)",
  async ({ splitting }) => {
    const directory = mkdtempSync(join(temporaryDirectory, "rsc-references-"));
    try {
      mkdirSync(join(directory, "output"));
      const clientPackage = join(directory, "node_modules/client-package");
      await Bun.write(
        join(clientPackage, "package.json"),
        JSON.stringify({ main: "counter.tsx", sideEffects: false })
      );
      await Bun.write(
        join(clientPackage, "counter.tsx"),
        `"use client";
import { useState } from "react";
export function Counter() {
  const [count, setCount] = useState(0);
  return <button onClick={() => setCount(count + 1)}>{count}</button>;
}`
      );
      await Bun.write(
        join(directory, "entry.tsx"),
        `import { renderServerComponent } from "@teyik0/furin/rsc";
import { renderToReadableStream } from "react-dom/server";
import { Counter } from "client-package";
const tree = await renderServerComponent(<Counter />);
console.log(await new Response(await renderToReadableStream(tree)).text());`
      );
      const build = await Bun.build({
        entrypoints: [join(directory, "entry.tsx")],
        external: ["react", "react-dom", "react-dom/*", "@teyik0/furin/rsc"],
        outdir: join(directory, "output"),
        plugins: [clientReferencesPlugin()],
        splitting,
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
  }
);

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

test.each([
  {
    name: "default",
    source: 'module.exports = function Counter() { return "CJS_IMPLEMENTATION"; };',
  },
  {
    name: "Counter",
    source: 'exports.Counter = function Counter() { return "CJS_IMPLEMENTATION"; };',
  },
  {
    name: "Counter",
    source: 'module.exports.Counter = function Counter() { return "CJS_IMPLEMENTATION"; };',
  },
  {
    name: "Counter",
    source: 'module.exports = { Counter: function Counter() { return "CJS_IMPLEMENTATION"; } };',
  },
])("the react-server graph preserves a CommonJS $name reference", async ({ name, source }) => {
  const directory = mkdtempSync(join(temporaryDirectory, "rsc-references-"));
  try {
    const counter = join(directory, "counter.js");
    const root = join(directory, "root.tsx");
    await Bun.write(counter, `"use client"; ${source}`);
    await Bun.write(
      root,
      `import ${name === "default" ? "Counter" : "{ Counter }"} from "./counter.js"; export const tree = <Counter />;`
    );
    const manifest = await buildRscGraph(
      [{ root: { path: root, route: {} as never }, routes: [] }],
      join(directory, "output"),
      "commonjs-reference",
      undefined
    );
    expect(manifest.clientReferences).toContainEqual({
      id: clientModuleId(counter),
      name,
      chunks: [],
    });
    const files = await Array.fromAsync(
      new Bun.Glob("**/*.js").scan({ cwd: join(directory, "output/rsc"), absolute: true })
    );
    const code = (await Promise.all(files.map((path) => Bun.file(path).text()))).join("\n");
    expect(code).not.toContain("CJS_IMPLEMENTATION");
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

async function buildClientReferenceNames(
  files: { [name: string]: string },
  root: string
): Promise<string[]> {
  const directory = mkdtempSync(join(temporaryDirectory, "rsc-references-"));
  try {
    await Promise.all(
      Object.entries({ ...files, "root.tsx": root }).map(([name, source]) =>
        Bun.write(join(directory, name), source)
      )
    );
    const manifest = await buildRscGraph(
      [{ root: { path: join(directory, "root.tsx"), route: {} as never }, routes: [] }],
      join(directory, "output"),
      "client-reference-names",
      undefined
    );
    return manifest.clientReferences.map(({ name }) => name);
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
}

test("the react-server graph does not treat an ES module that probes for module as CommonJS", async () => {
  const names = await buildClientReferenceNames(
    {
      "counter.js": `"use client";
export function Counter() { return null; }
if (typeof module !== "undefined" && module.hot) { module.hot.accept(); }`,
    },
    'import { Counter } from "./counter.js"; export const tree = <Counter />;'
  );
  expect(names).toEqual(["Counter"]);
});

test("the react-server graph names CommonJS exports defined with Object.defineProperty", async () => {
  const names = await buildClientReferenceNames(
    {
      "counter.js": `"use client";
function Counter() { return null; }
Object.defineProperty(exports, "__esModule", { value: true });
Object.defineProperty(exports, "Counter", { enumerable: true, get: function () { return Counter; } });`,
    },
    'import { Counter } from "./counter.js"; export const tree = <Counter />;'
  );
  expect(names.toSorted()).toEqual(["Counter", "default"]);
});

test("the react-server graph names CommonJS exports reexported with __exportStar", async () => {
  const names = await buildClientReferenceNames(
    {
      "counter.js": "exports.Counter = function Counter() { return null; };",
      "index.js": `"use client";
var __exportStar = function (m, exports) { for (var p in m) exports[p] = m[p]; };
__exportStar(require("./counter.js"), exports);`,
    },
    'import { Counter } from "./index.js"; export const tree = <Counter />;'
  );
  expect(names.toSorted()).toEqual(["Counter", "default"]);
});

test("SSR client registration does not classify shadowed module and exports as CommonJS", async () => {
  const directory = mkdtempSync(join(temporaryDirectory, "rsc-references-"));
  try {
    await Bun.write(
      join(directory, "component.ts"),
      '"use client"; export function local(module, exports) { return module.exports + exports; }'
    );
    const entry = join(directory, "entry.ts");
    await Bun.write(
      entry,
      'import { local } from "./component.ts"; console.log(local({ exports: "LOCAL" }, "_VALUE"));'
    );
    const built = await Bun.build({
      entrypoints: [entry],
      outdir: join(directory, "output"),
      plugins: [clientReferencesPlugin()],
      target: "bun",
    });
    expect(built.logs).toEqual([]);
    const child = Bun.spawn([process.execPath, join(directory, "output/entry.js")], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const [status, output, errors] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect({ status, output: output.trim(), errors }).toEqual({
      status: 0,
      output: "LOCAL_VALUE",
      errors: "",
    });
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

test.each(["development", "production", "compiled"])(
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
export const route = defineRoute("/").config({ mode: "isr", revalidate: 300 })
  .loader(async () => ({ header: await createCompositeComponent(({ children }) => <header><Link to="/blog/hello">Blog</Link><Counter />{children}</header>) }))
  .page(({ header }) => <CompositeComponent src={header}><span>Client slot</span></CompositeComponent>);`
      );
      if (mode === "compiled") {
        const result = await runCli(["build", "--target", "bun", "--compile", "server"], {
          cwd: app.path,
        });
        expect(result.exitCode, result.stderr + result.stdout).toBe(0);
      } else if (mode === "production") {
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
      const port = await getFreePort();
      const server = startProcess(
        mode === "compiled"
          ? [join(app.path, ".furin/build/bun/server")]
          : [
              process.execPath,
              join(
                app.path,
                mode === "production" ? ".furin/build/bun/server.js" : "src/server.ts"
              ),
            ],
        {
          cwd: app.path,
          env: {
            NODE_ENV: mode === "development" ? "development" : "production",
            PORT: String(port),
          },
        }
      );
      try {
        const response = await waitForHttp(`http://localhost:${port}/`, {
          timeoutMs: 5000,
          intervalMs: 250,
        });
        const html = await response.text();
        expect(response.status).toBe(200);
        expect(
          server
            .getStderr()
            .replace(/^Bundled page .*$/gm, "")
            .replace(
              /^warn: File .* is not in the project directory and will not be watched\r?$/gm,
              ""
            )
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
  "a Flight-only client component reexported by a barrel hydrates and handles clicks (%s)",
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
        join(directory, "barrel.ts"),
        '"use client"; import Counter from "./counter.tsx"; const Alias = Counter; export { Alias as default };'
      );
      await Bun.write(
        join(directory, "server.tsx"),
        `import { renderServerComponent, getRscSourceState } from "@teyik0/furin/rsc";
import { renderToReadableStream } from "react-dom/server";
import Counter from "./barrel.ts";
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
      const boundaries = await discoverClientBoundaries([join(directory, "server.tsx")], undefined);
      await Bun.write(
        join(directory, "browser.tsx"),
        `import { hydrateRoot } from "react-dom/client";
import { restoreRscSource } from "@teyik0/furin/rsc";
import payload from "./payload.json";
${generateClientReferenceEntry(boundaries)}
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

test("memo exports sharing a client function keep their own references and hydrate", async () => {
  const directory = mkdtempSync(join(temporaryDirectory, "rsc-references-"));
  try {
    await Bun.write(
      join(directory, "counter.tsx"),
      `"use client";
import { memo, useId, useState } from "react";
export function Plain() {
  const [count, setCount] = useState(0);
  return <button id={useId()} onClick={() => setCount(count + 1)}>{count}</button>;
}
export const First = memo(Plain);
export const Second = memo(Plain, () => false);`
    );
    await Bun.write(
      join(directory, "server.tsx"),
      `import { renderServerComponent, getRscSourceState } from "@teyik0/furin/rsc";
import { renderToReadableStream } from "react-dom/server";
import { First, Plain, Second } from "./counter.tsx";
const tree = await renderServerComponent(<><Plain /><First /><Second /></>);
const html = await new Response(await renderToReadableStream(tree)).text();
console.log(JSON.stringify({ html, bytes: [...getRscSourceState(tree).bytes] }));`
    );
    const server = await Bun.build({
      define: { "process.env.NODE_ENV": JSON.stringify("development") },
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
      env: { ...process.env, NODE_ENV: "development" },
    });
    const [status, payload, errors] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect(errors).toBe("");
    expect(status).toBe(0);
    const rows = new TextDecoder().decode(new Uint8Array(JSON.parse(payload).bytes)).split("\n");
    const imports = new Map(
      rows
        .filter((row) => row.includes(":I["))
        .map((row) => [
          row.slice(0, row.indexOf(":")),
          JSON.parse(row.slice(row.indexOf(":") + 2))[2],
        ])
    );
    const root = rows.find((row) => row.startsWith("0:")) ?? "";
    expect([...root.matchAll(/"\$L(\w+)"/g)].map(([, row]) => imports.get(String(row)))).toEqual([
      "Plain",
      "First",
      "Second",
    ]);
    await Bun.write(join(directory, "payload.json"), payload);
    const boundaries = await discoverClientBoundaries([join(directory, "server.tsx")], undefined);
    await Bun.write(
      join(directory, "browser.tsx"),
      `import { hydrateRoot } from "react-dom/client";
import { restoreRscSource } from "@teyik0/furin/rsc";
import payload from "./payload.json";
${generateClientReferenceEntry(boundaries)}
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
      define: { "process.env.NODE_ENV": JSON.stringify("development") },
    });
    expect(browser.success).toBe(true);
    await Bun.write(
      join(directory, "run.ts"),
      `import { installDom, waitForDom, uninstallDom } from ${JSON.stringify(join(import.meta.dir, "../../support/dom.ts"))};
installDom();
const { errors } = await import("./browser/browser.js");
await Bun.sleep(100);
document.querySelectorAll("button")[2].click();
await waitForDom(() => document.querySelectorAll("button")[2]?.textContent === "1", undefined);
console.log(JSON.stringify({ text: [...document.querySelectorAll("button")].map((button) => button.textContent), errors }));
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
    expect(JSON.parse(result)).toEqual({ text: ["0", "0", "1"], errors: [] });
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

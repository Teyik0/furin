import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import stripPlugin from "../../../src/plugin";
import { transformForClient } from "../../../src/plugin/transform-client";
import {
  isomorphicTransformPlugin,
  transformIsomorphicFunctions,
} from "../../../src/plugin/transform-isomorphic";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe("transformIsomorphicFunctions", () => {
  test("leaves unrelated client and server methods unchanged", () => {
    const source = 'export const value = api.server("production").client({ name: "browser" });';
    expect(transformForClient(source, "helper.ts").code).toBe(source);
  });
  test("selects the client implementation", () => {
    const result = transformIsomorphicFunctions(
      `
        import { createIsomorphicFn } from "@teyik0/furin";

        export const getValue = createIsomorphicFn()
          .server(() => "server-value")
          .client(() => "client-value");
      `,
      "shared.ts",
      "client"
    );

    expect(result.code).toContain('() => "client-value"');
    expect(result.code).not.toContain("server-value");
  });

  test("removes bindings referenced only by the discarded implementation", () => {
    const result = transformIsomorphicFunctions(
      `
        import { createIsomorphicFn } from "@teyik0/furin";
        import { readSecret } from "./server-secret";
        import { readBrowser } from "./browser";

        export const getValue = createIsomorphicFn()
          .server(() => readSecret())
          .client(() => readBrowser());
      `,
      "shared.ts",
      "client"
    );

    expect(result.code).not.toContain("./server-secret");
    expect(result.code).toContain("./browser");
  });

  test("supports a namespace import", () => {
    const result = transformIsomorphicFunctions(
      `
        import * as Furin from "furin";

        export const getValue = Furin.createIsomorphicFn()
          .client(() => "client-value")
          .server(() => "server-value");
      `,
      "shared.ts",
      "server"
    );

    expect(result.code).toContain('() => "server-value"');
    expect(result.code).not.toContain("client-value");
  });

  test("does not transform a shadowed import binding", () => {
    const result = transformIsomorphicFunctions(
      `
        import { createIsomorphicFn } from "@teyik0/furin";

        export function createLocal(createIsomorphicFn: () => unknown) {
          return createIsomorphicFn()
            .server(() => "local-server")
            .client(() => "local-client");
        }
      `,
      "shared.ts",
      "client"
    );

    expect(result.transformed).toBe(false);
    expect(result.code).toContain("local-server");
    expect(result.code).toContain("local-client");
  });

  test("rejects a chain split across statements", () => {
    expect(() =>
      transformIsomorphicFunctions(
        `
          import { createIsomorphicFn } from "@teyik0/furin";

          const builder = createIsomorphicFn();
          export const getValue = builder.server(() => "server-value");
        `,
        "shared.ts",
        "server"
      )
    ).toThrow("must use one fluent chain");
  });

  test("rejects a split chain declared inside a function", () => {
    expect(() =>
      transformIsomorphicFunctions(
        `
          import { createIsomorphicFn } from "@teyik0/furin";

          export function createValue() {
            const builder = createIsomorphicFn();
            return builder.server(() => "server-value");
          }
        `,
        "shared.ts",
        "server"
      )
    ).toThrow("must use one fluent chain");
  });

  test("rejects a split chain declared inside a nested block", () => {
    expect(() =>
      transformIsomorphicFunctions(
        `
          import { createIsomorphicFn } from "@teyik0/furin";

          if (enabled) {
            const builder = createIsomorphicFn();
            builder.client(() => "client-value");
          }
        `,
        "shared.ts",
        "client"
      )
    ).toThrow("must use one fluent chain");
  });

  test("rejects a var split chain used outside its declaring block", () => {
    expect(() =>
      transformIsomorphicFunctions(
        `
          import { createIsomorphicFn } from "@teyik0/furin";

          if (enabled) {
            var builder = createIsomorphicFn();
          }
          export const getValue = builder.client(() => "client-value");
        `,
        "shared.ts",
        "client"
      )
    ).toThrow("must use one fluent chain");
  });

  test("ignores split-chain method calls on a shadowed local binding", () => {
    const result = transformIsomorphicFunctions(
      `
        import { createIsomorphicFn } from "@teyik0/furin";

        const builder = createIsomorphicFn();
        function useLocal(builder) {
          return builder.server(() => "local");
        }
      `,
      "shared.ts",
      "server"
    );

    expect(result.code).toContain('builder.server(() => "local")');
  });

  test("selects statically computed environment methods", () => {
    const result = transformForClient(
        `
          import { createIsomorphicFn } from "@teyik0/furin";
          const serverMethod = "server" as const;
          export const getValue = createIsomorphicFn()[serverMethod](() => "SERVER_SECRET")["client"](() => "client");
        `,
        "shared.ts"
    );
    expect(result.code).toContain("client");
    expect(result.code).not.toContain("SERVER_SECRET");
  });

  test("the last environment implementation wins", () => {
    const result = transformForClient(`import { createIsomorphicFn } from "furin";
      export const value = createIsomorphicFn().client(() => "first").client(() => "last");`, "shared.ts");
    expect(result.code).toContain("last");
    expect(result.code).not.toContain("first");
  });

  test("rejects a runtime-selected environment method before bundling server code", () => {
    expect(() => transformForClient(`
      import { createIsomorphicFn } from "@teyik0/furin";
      export const getValue = createIsomorphicFn()[globalThis.method](() => "SERVER_SECRET").client(() => "public");
    `, "shared.ts")).toThrow("static .server() and .client() methods");
  });

  test.each([
    'let create = createIsomorphicFn; export const value = create().server(() => "SECRET");',
    'const factories = { create: createIsomorphicFn }; export const value = factories.create().server(() => "SECRET");',
  ])("rejects an opaque factory boundary: %s", (expression) => {
    expect(() => transformForClient(`import { createIsomorphicFn } from "furin"; ${expression}`, "shared.ts"))
      .toThrow("statically resolvable");
  });

  test("preserves methods on a named class expression that shadows the factory", () => {
    const source = `
      import { createIsomorphicFn } from "@teyik0/furin";
      export const Factory = class createIsomorphicFn {
        static value() { return createIsomorphicFn().server(() => "local"); }
      };
    `;
    expect(transformForClient(source, "shared.ts").code).toContain('createIsomorphicFn().server(() => "local")');
  });

  test("rejects computed environment methods on a split builder", () => {
    expect(() =>
      transformIsomorphicFunctions(
        `
          import { createIsomorphicFn } from "@teyik0/furin";
          const builder = createIsomorphicFn();
          export const getValue = builder["server"](() => "server");
        `,
        "shared.ts",
        "server"
      )
    ).toThrow("static .server() and .client() methods");
  });

  test("rejects computed environment methods on a function-local builder", () => {
    expect(() =>
      transformIsomorphicFunctions(
        `
          import { createIsomorphicFn } from "@teyik0/furin";

          export function createValue() {
            const builder = createIsomorphicFn();
            return builder["server"](() => "server");
          }
        `,
        "shared.ts",
        "server"
      )
    ).toThrow("static .server() and .client() methods");
  });

  test("rejects a computed var split chain used outside its declaring block", () => {
    expect(() =>
      transformIsomorphicFunctions(
        `
          import { createIsomorphicFn } from "@teyik0/furin";

          export function createValue() {
            if (enabled) {
              var builder = createIsomorphicFn();
            }
            return builder["server"](() => "server");
          }
        `,
        "shared.ts",
        "server"
      )
    ).toThrow("static .server() and .client() methods");
  });

  test("rejects a non-function implementation", () => {
    expect(() =>
      transformIsomorphicFunctions(
        `
          import { createIsomorphicFn } from "@teyik0/furin";
          export const getValue = createIsomorphicFn().server("not-a-function");
        `,
        "shared.ts",
        "server"
      )
    ).toThrow("must receive a function");
  });

  test("uses a no-op when the target branch is absent", () => {
    const result = transformIsomorphicFunctions(
      `
        import { createIsomorphicFn as isomorphic } from "@teyik0/furin";
        import { readSecret } from "./server-secret";

        export const getValue = isomorphic().server(() => readSecret());
      `,
      "shared.ts",
      "client"
    );

    expect(result.code).toContain("() => undefined");
    expect(result.code).not.toContain("readSecret");
  });

  test("supports referenced functions, factories, and immediate invocation", () => {
    const result = transformIsomorphicFunctions(
      `
        import { createIsomorphicFn } from "@teyik0/furin";

        const readServer = () => "server";
        const readClient = () => "client";

        export function createReader() {
          return createIsomorphicFn().server(readServer).client(readClient);
        }

        export const value = createIsomorphicFn()
          .client(readClient)
          .server(readServer)();
      `,
      "shared.ts",
      "server"
    );

    expect(result.code).toContain("return (readServer)");
    expect(result.code).toContain("(readServer)()");
    expect(result.code).not.toContain("createIsomorphicFn");
  });

  test("preserves immediate invocation precedence", () => {
    const result = transformIsomorphicFunctions(
      `
        import { createIsomorphicFn } from "@teyik0/furin";

        export const value = createIsomorphicFn()
          .server(() => "server-value")
          .client(() => "client-value")();
      `,
      "shared.ts",
      "server"
    );

    expect(result.code).toContain('(() => "server-value")()');
  });

  test("transforms multiple independent chains", () => {
    const result = transformIsomorphicFunctions(
      `
        import { createIsomorphicFn } from "@teyik0/furin";

        export const first = createIsomorphicFn()
          .server(() => "first-server")
          .client(() => "first-client");
        export const second = createIsomorphicFn()
          .client(() => "second-client")
          .server(() => "second-server");
      `,
      "shared.ts",
      "client"
    );

    expect(result.code).toContain("first-client");
    expect(result.code).toContain("second-client");
    expect(result.code).not.toContain("first-server");
    expect(result.code).not.toContain("second-server");
  });
});

test("transformForClient applies the client isomorphic branch", () => {
  const result = transformForClient(
    `
      import { createIsomorphicFn } from "@teyik0/furin";
      import { readServerValue } from "./server";

      export const getValue = createIsomorphicFn()
        .server(() => readServerValue())
        .client(() => "client-value");
    `,
    "shared.ts"
  );

  expect(result.code).toContain("client-value");
  expect(result.code).not.toContain("readServerValue");
});

test("browser bundles remove server secrets through constant factory and method aliases", async () => {
  const root = mkdtempSync(join(tmpdir(), "furin-isomorphic-alias-"));
  temporaryDirectories.push(root);
  const entrypoint = join(root, "entry.ts");
  writeFileSync(entrypoint, `
    import { createIsomorphicFn } from "@teyik0/furin";
    const create = createIsomorphicFn;
    const method = "server" as const;
    export const getValue = create()[method](() => "SERVER_SECRET").client(() => "PUBLIC_VALUE");
  `);
  const result = await Bun.build({ entrypoints: [entrypoint], plugins: [stripPlugin], target: "browser" });
  expect(result.success).toBe(true);
  const output = await result.outputs[0]?.text();
  expect(output).toContain("PUBLIC_VALUE");
  expect(output).not.toContain("SERVER_SECRET");
});

test.each(["js", "jsx", "ts", "tsx", "mjs", "cjs", "mts", "cts"])(
  "the server build plugin excludes the client module from a .%s bundle",
  async (extension) => {
  const root = mkdtempSync(join(tmpdir(), "furin-isomorphic-server-"));
  temporaryDirectories.push(root);
  writeFileSync(join(root, "server.ts"), 'export const value = "SERVER_MARKER";');
  writeFileSync(join(root, "client.ts"), 'export const value = "CLIENT_MARKER";');
  writeFileSync(
    join(root, `entry.${extension}`),
    `
      import { createIsomorphicFn } from "@teyik0/furin";
      import { value as serverValue } from "./server";
      import { value as clientValue } from "./client";

      export const getValue = createIsomorphicFn()
        .server(() => serverValue)
        .client(() => clientValue);
    `
  );

  const result = await Bun.build({
    entrypoints: [join(root, `entry.${extension}`)],
    external: ["@teyik0/furin"],
    outdir: join(root, "out"),
    plugins: [isomorphicTransformPlugin("server")],
    target: "bun",
  });
  const output = readFileSync(result.outputs[0]?.path ?? "", "utf8");

  expect(output).toContain("SERVER_MARKER");
  expect(output).not.toContain("CLIENT_MARKER");
  }
);

test.each(["js", "jsx", "ts", "tsx", "mjs", "cjs", "mts", "cts"])(
  "the browser strip plugin selects the client branch in a .%s route",
  async (extension) => {
    const root = mkdtempSync(join(tmpdir(), "furin-isomorphic-client-"));
    temporaryDirectories.push(root);
    writeFileSync(
      join(root, `entry.${extension}`),
      `
        import { createIsomorphicFn } from "@teyik0/furin";
        export const getValue = createIsomorphicFn()
          .server(() => "SERVER_MARKER")
          .client(() => "CLIENT_MARKER");
      `
    );

    const result = await Bun.build({
      entrypoints: [join(root, `entry.${extension}`)],
      external: ["@teyik0/furin"],
      outdir: join(root, "out"),
      plugins: [stripPlugin],
      target: "browser",
    });
    const output = readFileSync(result.outputs[0]?.path ?? "", "utf8");

    expect(output).toContain("CLIENT_MARKER");
    expect(output).not.toContain("SERVER_MARKER");
  }
);

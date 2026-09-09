/**
 * Regression tests — schema merging in createRoutePlugin (router.ts).
 *
 * Fix: mergeRouteSchemas() merges all TObject.properties across the routeChain
 * into a single t.Object so every ancestor's fields are present in the Elysia guard.
 *
 * Fixture: pages/schema-merge-parent/child/index.tsx
 *   routeChain = [rootRoute, parentRoute (parentFilter default), childRoute (childFilter default)]
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import "../../setup/evlog-mock";

import { Elysia, t } from "elysia";
import type { RuntimeRoute } from "../../../src/client/internal/runtime-types.ts";
import { collectRouteTags } from "../../../src/server/router/discovery.ts";
import { mergeRouteSchemas } from "../../../src/server/router/schema-merge.ts";
import { parseRouteQuery } from "../../../src/server/router/schemas.ts";
import { __setDevMode, IS_DEV } from "../../../src/server/runtime-env.ts";

const ROUTER_TESTS_DIR_RE = /\/tests(?:\/.*)?$/;

let originalDevMode: boolean;
beforeAll(() => {
  originalDevMode = IS_DEV;
  __setDevMode(false);
});
afterAll(() => __setDevMode(originalDevMode));

// ── mergeRouteSchemas unit tests ─────────────────────────────────────────────

describe("mergeRouteSchemas", () => {
  test("returns undefined when no entry in chain has the key", () => {
    const chain: RuntimeRoute[] = [{ __type: "FURIN_ROUTE" }, { __type: "FURIN_ROUTE" }];
    expect(mergeRouteSchemas(chain, "query")).toBeUndefined();
    expect(mergeRouteSchemas(chain, "params")).toBeUndefined();
  });

  test("returns the schema directly when only one entry has it", () => {
    const schema = t.Object({ city: t.Optional(t.String()) });
    const chain: RuntimeRoute[] = [
      { __type: "FURIN_ROUTE" },
      { __type: "FURIN_ROUTE", query: schema },
    ];
    expect(mergeRouteSchemas(chain, "query")).toBe(schema);
  });

  test("merges properties from multiple entries — both keys present in result", () => {
    const parent = t.Object({ parentField: t.Optional(t.String()) });
    const child = t.Object({ childField: t.Optional(t.String()) });
    const chain: RuntimeRoute[] = [
      { __type: "FURIN_ROUTE" },
      { __type: "FURIN_ROUTE", query: parent },
      { __type: "FURIN_ROUTE", query: child },
    ];

    const merged = mergeRouteSchemas(chain, "query") as ReturnType<typeof t.Object>;

    expect(merged).toBeDefined();
    expect(merged.properties).toHaveProperty("parentField");
    expect(merged.properties).toHaveProperty("childField");
  });

  test("leaf schema wins on key conflict", () => {
    const parentVal = t.String({ default: "parent" });
    const childVal = t.String({ default: "child" });
    const parent = t.Object({ shared: t.Optional(parentVal) });
    const child = t.Object({ shared: t.Optional(childVal) });
    const chain: RuntimeRoute[] = [
      { __type: "FURIN_ROUTE", query: parent },
      { __type: "FURIN_ROUTE", query: child },
    ];

    const merged = mergeRouteSchemas(chain, "query") as ReturnType<typeof t.Object>;

    // child is last → its Optional(childVal) wins
    const sharedSchema = merged.properties.shared as { [key: string]: unknown };
    expect(JSON.stringify(sharedSchema)).toContain('"child"');
  });

  test("returns a single non-TypeBox schema unchanged", () => {
    const schema = { "~standard": {} };
    const chain = [{ __type: "FURIN_ROUTE" as const, query: schema }];

    expect(mergeRouteSchemas(chain as RuntimeRoute[], "query")).toBe(schema);
  });

  test("throws a clear error when multi-route query merge is not TypeBox", () => {
    const parent = t.Object({ parentField: t.Optional(t.String()) });
    const child = { "~standard": {} };
    const chain = [
      { __type: "FURIN_ROUTE" as const, query: parent },
      { __type: "FURIN_ROUTE" as const, query: child },
    ];

    expect(() => mergeRouteSchemas(chain as RuntimeRoute[], "query")).toThrow(
      "[furin] Merging query schemas across the route chain requires TypeBox in V1. Use TypeBox for parent/child query, or define query only on leaf routes."
    );
  });

  test("throws when multi-route schemas include a plain JSON Schema object", () => {
    const parent = t.Object({ parentField: t.Optional(t.String()) });
    const child = {
      properties: { childField: { type: "string" } },
      required: ["childField"],
      type: "object",
    };
    const chain = [
      { __type: "FURIN_ROUTE" as const, query: parent },
      { __type: "FURIN_ROUTE" as const, query: child },
    ];

    expect(() => mergeRouteSchemas(chain as RuntimeRoute[], "query")).toThrow(
      "[furin] Merging query schemas across the route chain requires TypeBox in V1. Use TypeBox for parent/child query, or define query only on leaf routes."
    );
  });
});

describe("parseRouteQuery", () => {
  test("matches Elysia query parsing when no query schema exists", async () => {
    const app = new Elysia().get("/products", ({ query }) => Response.json(query));
    const response = await app.handle(
      new Request("http://localhost/products?tag=react&tag=furin&active=true")
    );
    const elysiaQuery = await response.json();

    const result = await parseRouteQuery(
      new URL("http://localhost/products?tag=react&tag=furin&active=true"),
      undefined
    );

    expect(result).toEqual({ ok: true, query: elysiaQuery });
  });

  test("coerces anyOf array and object query schemas", async () => {
    const schema = t.Object({
      filter: t.Union([t.Object({ category: t.String() }), t.Null()]),
      tags: t.Union([t.Array(t.String()), t.Null()]),
    });

    const result = await parseRouteQuery(
      new URL('http://localhost/products?tags=react&tags=furin&filter={"category":"framework"}'),
      schema
    );

    expect(result).toEqual({
      ok: true,
      query: {
        filter: { category: "framework" },
        tags: ["react", "furin"],
      },
    });
  });
});

describe("collectRouteTags", () => {
  test("deduplicates route-chain and page-level tags", () => {
    const chain: RuntimeRoute[] = [
      { __type: "FURIN_ROUTE", tags: ["root", "shared"] },
      { __type: "FURIN_ROUTE", tags: ["board", "shared"] },
    ];
    const page = {
      __type: "FURIN_PAGE" as const,
      _route: chain[1] as RuntimeRoute,
      component: () => null,
      tags: ["cards", "board"],
    };

    expect(collectRouteTags(chain, page)).toEqual(["root", "shared", "board", "cards"]);
  });

  test("returns undefined when no route or page tags exist", () => {
    const chain: RuntimeRoute[] = [{ __type: "FURIN_ROUTE" }];

    expect(collectRouteTags(chain, undefined)).toBeUndefined();
  });
});

// ── Integration: HTTP requests resolve defaults from all ancestors ────────────

describe("schema merge — parent + child both declare query schemas", () => {
  test("HTTP requests resolve merged query defaults", () => {
    const proc = Bun.spawnSync({
      cmd: [
        "bun",
        "-e",
        `
import { expect } from "bun:test";

await import("./tests/setup/evlog-mock.ts");

const { Elysia } = await import("elysia");
const { join } = await import("node:path");
const { scanPages } = await import("./src/server/router/discovery.ts");
const { createRoutePlugin } = await import("./src/server/router/plugin.ts");
const { __setDevMode, IS_DEV } = await import("./src/server/runtime-env.ts");

const originalDevMode = IS_DEV;
const routePattern = "/schema-merge-parent/child";
__setDevMode(false);

try {
  const result = await scanPages(join(import.meta.dir, "tests/fixtures/pages/default"));
  const route = result.routes.find((candidate) => candidate.pattern === routePattern);
  if (!route) {
    throw new Error("Route " + routePattern + " not found");
  }

  const chainEntries = route.routeChain.filter((entry) => entry.query);
  // Parent layout, child layout, and the leaf terminal each carry their local
  // Elysia query contract in the generated route chain.
  expect(chainEntries.length).toBe(3);

  let app = new Elysia().use(createRoutePlugin(route, result.root));
  let res = await app.handle(new Request("http://localhost" + routePattern));
  expect(res.status).toBe(200);
  expect(res.headers.get("location")).toBeNull();

  app = new Elysia().use(createRoutePlugin(route, result.root));
  res = await app.handle(
    new Request("http://localhost" + routePattern + "?parentFilter=parent-default&childFilter=child-default")
  );
  expect(res.status).toBe(200);
} finally {
  __setDevMode(originalDevMode);
}
process.exit(0);
`,
      ],
      cwd: import.meta.dir.replace(ROUTER_TESTS_DIR_RE, ""),
      stderr: "pipe",
      stdout: "pipe",
    });

    if (proc.exitCode !== 0) {
      throw new Error(
        [
          `schema merge subprocess exited with ${proc.exitCode}`,
          new TextDecoder().decode(proc.stdout),
          new TextDecoder().decode(proc.stderr),
        ].join("\n")
      );
    }

    expect(proc.exitCode).toBe(0);
  });
});

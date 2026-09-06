// biome-ignore-all lint/performance/noAwaitInLoops: a request benchmark is sequential by definition
// biome-ignore-all lint/style/noNonNullAssertion: bench fixture indexing is clamped by construction
/**
 * Bench end-to-end : coût de la validation params obligatoire (R13).
 *
 * Mesure, sur le serveur réel (in-process app.handle) :
 *   1. Le coût PUR de la validation Elysia — deux routes nues identiques,
 *      avec vs sans schéma params.
 *   2. Le coût E2E Furin — deux apps complètes (routing + loader + render),
 *      page dynamique avec le squelette auto-injecté vs page statique.
 *
 * Usage : bun packages/core/tests/bench/params-validation.bench.ts
 */

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Elysia, t } from "elysia";
import type { FurinOptions } from "../../src/furin.ts";
import { furin } from "../../src/furin.ts";

const REQUESTS = 20_000;
const WARMUP = 2000;

interface BenchResult {
  label: string;
  meanUs: number;
  medianUs: number;
}

function percentile(sorted: number[], p: number): number {
  const index = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[index]!;
}

async function benchHandle(
  label: string,
  app: { handle: (request: Request) => Promise<Response> },
  url: string,
  requests: number
): Promise<BenchResult> {
  for (let i = 0; i < WARMUP; i += 1) {
    await app.handle(new Request(url));
  }
  const samples: number[] = [];
  for (let i = 0; i < requests; i += 1) {
    const start = performance.now();
    const response = await app.handle(new Request(url));
    await response.text();
    samples.push((performance.now() - start) * 1000);
  }
  samples.sort((left, right) => left - right);
  const mean = samples.reduce((total, value) => total + value, 0) / samples.length;
  return { label, meanUs: mean, medianUs: percentile(samples, 50) };
}

// ── 1. Coût pur de la validation Elysia (micro) ────────────────────────────

const withSchemaApp = new Elysia().get("/x/:id", ({ params }) => params.id, {
  params: t.Object({ id: t.String() }),
});

const withoutSchemaApp = new Elysia().get("/x/:id", ({ params }) => params.id);

// ── 2. E2E Furin — page dynamique avec le squelette auto-injecté ───────────

const benchRoot = mkdtempSync(join(import.meta.dir, "../../.tmp-tests/", "furin-bench-"));
const pagesDir = join(benchRoot, "pages");
mkdirSync(join(pagesDir, "posts"), { recursive: true });

writeFileSync(
  join(pagesDir, "root.tsx"),
  `import { defineRootRoute } from "@teyik0/furin";
export const route = defineRootRoute().config({ mode: "ssr" }).layout(({ children }) => children);
`
);
writeFileSync(
  join(pagesDir, "posts/[id].tsx"),
  `import { defineRoute } from "@teyik0/furin";
import { t } from "elysia";
import { route as rootRoute } from "../root";

export const route = defineRoute()
  .config({ layout: rootRoute, mode: "ssr", params: t.Object({ id: t.String() }) })
  .loader(({ params }) => ({ id: params.id }))
  .page(({ data }) => data.id);
`
);
writeFileSync(
  join(pagesDir, "index.tsx"),
  `import { defineRoute } from "@teyik0/furin";
import { route as rootRoute } from "./root";

export const route = defineRoute()
  .config({ layout: rootRoute, mode: "ssr" })
  .page(() => "home");
`
);

const benchApp = new Elysia().use(await furin({ pagesDir } as FurinOptions));

// ── Exécution ──────────────────────────────────────────────────────────────

const results: BenchResult[] = [];

results.push(
  await benchHandle(
    "Elysia nu — sans schéma params",
    withoutSchemaApp,
    "http://localhost/x/42",
    REQUESTS
  )
);
results.push(
  await benchHandle(
    "Elysia nu — AVEC params t.String",
    withSchemaApp,
    "http://localhost/x/42",
    REQUESTS
  )
);
results.push(
  await benchHandle("Furin E2E — page statique /", benchApp, "http://localhost/", REQUESTS)
);
results.push(
  await benchHandle(
    "Furin E2E — page dynamique /posts/:id (squelette t.String)",
    benchApp,
    "http://localhost/posts/42",
    REQUESTS
  )
);

console.log("\n=== Bench validation params (R13) — in-process app.handle ===\n");
console.table(
  results.map((result) => ({
    "moyenne µs": result.meanUs.toFixed(1),
    "médiane µs": result.medianUs.toFixed(1),
    scénario: result.label,
  }))
);

const elysiaWithout = results.find((result) => result.label.includes("sans schéma"))!;
const elysiaWith = results.find((result) => result.label.includes("AVEC params"))!;
const furinStatic = results.find((result) => result.label.includes("page statique"))!;
const furinDynamic = results.find((result) => result.label.includes("page dynamique"))!;

const validationOverhead = elysiaWith.medianUs - elysiaWithout.medianUs;
const dynamicOverhead = furinDynamic.medianUs - furinStatic.medianUs;

console.log(`
=== Lecture ===
Overhead validation Elysia (params t.String) : ${validationOverhead.toFixed(1)} µs/req (médiane)
Overhead chemin dynamique Furin E2E          : ${dynamicOverhead.toFixed(1)} µs/req (médiane)
(en % d'une requête SSR à 25 ms : ${((validationOverhead / 25_000) * 100).toFixed(3)} %)
`);

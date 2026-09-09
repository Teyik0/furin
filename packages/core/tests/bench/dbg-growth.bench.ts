// biome-ignore-all lint/performance/noAwaitInLoops: benchmark

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Elysia } from "elysia";
import type { FurinOptions } from "../../src/furin";
import { furin } from "../../src/furin.ts";

if (globalThis.gc === undefined) {
  throw new Error("Run this benchmark with bun --expose-gc");
}

const benchRoot = mkdtempSync(join(import.meta.dir, "../../.tmp-tests/", "dbg-growth-"));
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
export const route = defineRoute().config({ layout: rootRoute, mode: "ssr" }).page(() => "home");
`
);

const options = { pagesDir } as FurinOptions;
const app = new Elysia().use(await furin(options));

const TOTAL = 20_000;
const BUCKET = 1000;
const dynamic: number[] = [];
const heapSeries: Array<{ n: number; heapMb: number }> = [];

let bucketAcc: number[] = [];

for (let i = 0; i < TOTAL; i += 1) {
  const start = performance.now();
  const response = await app.handle(new Request(`http://localhost/posts/${i}`));
  await response.text();
  bucketAcc.push((performance.now() - start) * 1000);
  if (i % BUCKET === BUCKET - 1) {
    const sorted = [...bucketAcc].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    if (median === undefined) {
      throw new Error("Cannot calculate the median of an empty bucket");
    }
    dynamic.push(median);
    globalThis.gc();
    const mem = process.memoryUsage();
    heapSeries.push({ heapMb: mem.heapUsed / 1e6, n: i + 1 });
    bucketAcc = [];
  }
}

console.log(
  "\n=== Latence médiane /posts/:id par tranche de 1 000 requêtes (AVEC cache mtime) ==="
);
dynamic.forEach((us, index) => {
  const heap = heapSeries[index]?.heapMb ?? 0;
  console.log(
    `  ${String((index + 1) * BUCKET).padStart(6)} req : ${us.toFixed(1).padStart(8)} µs | heap ${heap.toFixed(1)} MB`
  );
});

const [first] = heapSeries;
const last = heapSeries.at(-1);
if (!(first && last)) {
  throw new Error("Cannot report heap growth without measurements");
}
console.log(
  `\nHeap : ${first.heapMb.toFixed(1)} -> ${last.heapMb.toFixed(1)} MB (delta ${(last.heapMb - first.heapMb).toFixed(1)} MB)`
);

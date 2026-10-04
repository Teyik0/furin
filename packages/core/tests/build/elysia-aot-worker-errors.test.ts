import { expect, test } from "bun:test";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { elysiaAot } from "../../src/build/elysia-aot.ts";
import type {
  AotWorkerConfig,
  AotWorkerRequest,
  AotWorkerResponse,
} from "../../src/build/elysia-aot-worker.ts";
import { createTmpApp, writeAppFile } from "../support/app-fixtures.ts";

test("AOT worker preserves entry diagnostics without cloning the error cause", async () => {
  const app = createTmpApp("cli-app");
  const entry = join(app.path, "failing-entry.ts");
  writeAppFile(
    app.path,
    "failing-entry.ts",
    `const error = new Error("AOT entry cannot initialize", { cause: () => {} });
error.name = "AotEntryError";
error.stack = "AotEntryError: AOT entry cannot initialize\\n    at failing-entry.ts:1:1";
throw error;`
  );
  const worker = new Worker(join(import.meta.dir, "../../src/build/elysia-aot-worker.ts"), {
    workerData: { entry, target: "bun" } satisfies AotWorkerConfig,
  });
  try {
    const response = await new Promise<AotWorkerResponse>((resolve, reject) => {
      worker.once("message", resolve);
      worker.once("error", reject);
      worker.postMessage({ id: 1, method: "start" } satisfies AotWorkerRequest);
    });
    expect(response.ok).toBe(false);
    if (response.ok) {
      throw new Error("Expected the AOT entry to fail.");
    }
    expect(response.id).toBe(1);
    expect(response.error).toEqual({
      message: "AOT entry cannot initialize",
      name: "AotEntryError",
      stack: "AotEntryError: AOT entry cannot initialize\n    at failing-entry.ts:1:1",
    });
  } finally {
    await worker.terminate();
    app.cleanup();
  }
});

test("AOT build still skips apps with mounted sub-apps", async () => {
  const app = createTmpApp("cli-app");
  const entry = join(app.path, "mounted-entry.ts");
  writeAppFile(
    app.path,
    "mounted-entry.ts",
    `import { Elysia } from "elysia";
export default new Elysia().mount("/child", () => new Response("mounted"));`
  );
  try {
    const build = await Bun.build({
      entrypoints: [entry],
      plugins: [elysiaAot(entry)],
      target: "bun",
    });
    expect(build.success).toBe(true);
  } finally {
    app.cleanup();
  }
});

test("AOT build reports the original DOMException diagnostic from the worker", async () => {
  const app = createTmpApp("cli-app");
  const entry = join(app.path, "failing-entry.ts");
  writeAppFile(
    app.path,
    "failing-entry.ts",
    `const error = new DOMException("AOT entry has invalid state", "InvalidStateError");
error.stack = "InvalidStateError: AOT entry has invalid state\\n    at failing-entry.ts:1:1";
throw error;`
  );
  try {
    const build = (async () =>
      await Bun.build({ entrypoints: [entry], plugins: [elysiaAot(entry)], target: "bun" }))();
    await expect(build).rejects.toBeInstanceOf(Error);
    await expect(build).rejects.toMatchObject({
      message: "AOT entry has invalid state",
      name: "InvalidStateError",
      stack: "InvalidStateError: AOT entry has invalid state\n    at failing-entry.ts:1:1",
    });
  } finally {
    app.cleanup();
  }
});

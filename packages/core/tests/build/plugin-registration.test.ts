import { expect, test } from "bun:test";
import type { BunPlugin } from "bun";
import { buildApp } from "../../src/build/index.ts";
import { createTmpApp } from "../support/app-fixtures.ts";

test("buildApp fails with an actionable error when a plugin cannot register at runtime", async () => {
  const app = createTmpApp("cli-app");
  const clientOnlyPlugin: BunPlugin = {
    name: "client-only-plugin",
    setup(build) {
      // Mirrors bun-plugin-tailwind: onBeforeParse exists only in Bun.build().
      (build as unknown as { onBeforeParse: () => void }).onBeforeParse();
    },
  };
  try {
    await expect(
      buildApp({ plugins: [clientOnlyPlugin], rootDir: app.path, target: "bun" })
    ).rejects.toThrow(
      '[furin] Plugin "client-only-plugin" could not be registered for server-side route imports'
    );
    await expect(
      buildApp({ plugins: [clientOnlyPlugin], rootDir: app.path, target: "bun" })
    ).rejects.toThrow("plugins: [{ ...plugin, buildOnly: true }]");
  } finally {
    app.cleanup();
  }
});

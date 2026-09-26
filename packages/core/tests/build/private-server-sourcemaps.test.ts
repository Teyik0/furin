import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { movePrivateServerSourceMaps } from "../../src/build/private-server-sourcemaps.ts";
import { createTmpApp } from "../support/app-fixtures.ts";

describe("private server source maps", () => {
  test("moves only server maps outside the deployable directory", () => {
    const app = createTmpApp("cli-app");
    try {
      const output = join(app.path, "deploy");
      const privateDir = join(app.path, ".furin/build/private/server-sourcemaps/bun");
      mkdirSync(output, { recursive: true });
      writeFileSync(join(output, "server.js"), "//# debugId=abc\n");
      writeFileSync(join(output, "server.js.map"), '{"debugId":"abc"}');
      writeFileSync(join(output, "client.js.map"), "client");

      movePrivateServerSourceMaps(output, privateDir, ["server.js.map"]);

      expect(existsSync(join(output, "server.js.map"))).toBe(false);
      expect(existsSync(join(privateDir, "server.js.map"))).toBe(true);
      expect(existsSync(join(output, "client.js.map"))).toBe(true);
    } finally {
      app.cleanup();
    }
  });

  test("moves nested maps using their exact Bun output path", () => {
    const app = createTmpApp("cli-app");
    try {
      const output = join(app.path, "deploy");
      const source = join(output, "chunks", "server.js.map");
      const privateDir = join(app.path, ".furin/build/private/server-sourcemaps/bun");
      mkdirSync(join(output, "chunks"), { recursive: true });
      writeFileSync(source, "nested map");

      movePrivateServerSourceMaps(output, privateDir, [source]);

      expect(existsSync(source)).toBe(false);
      expect(existsSync(join(privateDir, "chunks", "server.js.map"))).toBe(true);
    } finally {
      app.cleanup();
    }
  });
});

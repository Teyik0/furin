import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  movePrivateServerSourceMaps,
  privateServerSourceMapDir,
} from "../../src/build/private-server-sourcemaps.ts";

describe("private server source maps", () => {
  test("moves only server maps outside the deployable directory", () => {
    const root = mkdtempSync(join(tmpdir(), "furin-private-maps-"));
    try {
      const output = join(root, "deploy");
      const privateDir = join(root, ".furin/build/private/server-sourcemaps/bun");
      mkdirSync(output, { recursive: true });
      writeFileSync(join(output, "server.js"), "//# debugId=abc\n");
      writeFileSync(join(output, "server.js.map"), '{"debugId":"abc"}');
      writeFileSync(join(output, "client.js.map"), "client");

      movePrivateServerSourceMaps(output, privateDir, ["server.js.map"]);

      expect(existsSync(join(output, "server.js.map"))).toBe(false);
      expect(existsSync(join(privateDir, "server.js.map"))).toBe(true);
      expect(existsSync(join(output, "client.js.map"))).toBe(true);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  test("moves nested maps using their exact Bun output path", () => {
    const root = mkdtempSync(join(tmpdir(), "furin-private-maps-"));
    try {
      const output = join(root, "deploy");
      const source = join(output, "chunks", "server.js.map");
      const privateDir = join(root, ".furin/build/private/server-sourcemaps/bun");
      mkdirSync(join(output, "chunks"), { recursive: true });
      writeFileSync(source, "nested map");

      movePrivateServerSourceMaps(output, privateDir, [source]);

      expect(existsSync(source)).toBe(false);
      expect(existsSync(join(privateDir, "chunks", "server.js.map"))).toBe(true);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  test("keeps each adapter's maps in its own private directory", () => {
    expect(privateServerSourceMapDir("/app/.furin/build", "vercel")).toBe(
      join("/app/.furin/build", "private", "server-sourcemaps", "vercel")
    );
  });
});

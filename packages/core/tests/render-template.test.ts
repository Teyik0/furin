import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  __resetTemplateState,
  getDevTemplate,
  getProductionTemplate,
  setProductionTemplateContent,
  setProductionTemplatePath,
} from "../src/render/template";

beforeEach(() => {
  __resetTemplateState();
});

afterEach(() => {
  __resetTemplateState();
});

describe.serial("render/template", () => {
  test("getProductionTemplate returns null until a template path is set", () => {
    expect(getProductionTemplate()).toBeNull();
  });

  test("getProductionTemplate reads the configured template from disk", () => {
    const dir = mkdtempSync(join(tmpdir(), "furin-template-"));
    const file = join(dir, "index.html");
    writeFileSync(file, "<html>prod-template</html>");

    setProductionTemplatePath(file);

    expect(getProductionTemplate()).toBe("<html>prod-template</html>");
  });

  test("setProductionTemplateContent is returned by getProductionTemplate (embed mode)", () => {
    setProductionTemplateContent("<html>embedded</html>");
    expect(getProductionTemplate()).toBe("<html>embedded</html>");
  });

  test("setProductionTemplateContent takes priority over path-based template", () => {
    const dir = mkdtempSync(join(tmpdir(), "furin-template-"));
    const file = join(dir, "index.html");
    writeFileSync(file, "<html>from-disk</html>");

    setProductionTemplatePath(file);
    expect(getProductionTemplate()).toBe("<html>from-disk</html>");

    setProductionTemplateContent("<html>from-memory</html>");
    expect(getProductionTemplate()).toBe("<html>from-memory</html>");
  });

  test("getDevTemplate caches within TTL and re-fetches after expiry", async () => {
    let requestCount = 0;
    const server = Bun.serve({
      port: 0,
      fetch() {
        requestCount += 1;
        return new Response("<html>dev-template</html>");
      },
    });

    try {
      const origin = server.url.origin;

      const first = await getDevTemplate(origin);
      const second = await getDevTemplate(origin);

      expect(first).toBe("<html>dev-template</html>");
      expect(second).toBe("<html>dev-template</html>");
      // Second call within 1s TTL should hit the cache
      expect(requestCount).toBe(1);
    } finally {
      server.stop(true);
    }
  }, 10_000);

  test("getDevTemplate throws on failed fetch", async () => {
    const server = Bun.serve({
      port: 0,
      fetch() {
        return new Response("boom", { status: 500 });
      },
    });

    try {
      const origin = server.url.origin;
      await expect(getDevTemplate(origin)).rejects.toThrow("/_bun_hmr_entry returned 500");
    } finally {
      server.stop(true);
    }
  }, 10_000);
});

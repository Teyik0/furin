import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  getDevTemplate,
  getProductionTemplate,
  setProductionTemplateContent,
  setProductionTemplatePath,
} from "../src/render/template";

afterEach(() => {
  setProductionTemplatePath(null);
});

describe.serial("render/template", () => {
  test("getProductionTemplate returns null until a template path is set", () => {
    expect(getProductionTemplate()).toBeNull();
  });

  test("getProductionTemplate reads the configured template from disk", () => {
    const dir = mkdtempSync(join(tmpdir(), "elyra-template-"));
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
    const dir = mkdtempSync(join(tmpdir(), "elyra-template-"));
    const file = join(dir, "index.html");
    writeFileSync(file, "<html>from-disk</html>");

    setProductionTemplatePath(file);
    expect(getProductionTemplate()).toBe("<html>from-disk</html>");

    setProductionTemplateContent("<html>from-memory</html>");
    expect(getProductionTemplate()).toBe("<html>from-memory</html>");
  });

  test("getDevTemplate caches a successful fetch result", async () => {
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
      expect(requestCount).toBe(1);
    } finally {
      server.stop(true);
    }
  }, 10_000);

  test("getDevTemplate resets its cache after a failed fetch", async () => {
    let shouldFail = true;
    let requestCount = 0;
    const server = Bun.serve({
      port: 0,
      fetch() {
        requestCount += 1;
        if (shouldFail) {
          return new Response("boom", { status: 500 });
        }
        return new Response("<html>recovered-template</html>");
      },
    });

    try {
      const origin = server.url.origin;

      await expect(getDevTemplate(origin)).rejects.toThrow("/_bun_hmr_entry returned 500");

      shouldFail = false;
      const recovered = await getDevTemplate(origin);

      expect(recovered).toBe("<html>recovered-template</html>");
      expect(requestCount).toBe(2);
    } finally {
      server.stop(true);
    }
  }, 10_000);
});

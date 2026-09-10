import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  __resetTemplateState,
  documentAssetsFromTemplate,
  getDevTemplate,
  getProductionTemplate,
  setProductionTemplateContent,
  setProductionTemplatePath,
} from "../../../src/server/render/template.ts";

beforeEach(() => {
  __resetTemplateState();
});

afterEach(() => {
  __resetTemplateState();
});

describe.serial("render/template", () => {
  test("derives the application entry after development-only module scripts", () => {
    const assets = documentAssetsFromTemplate(
      '<script data-furin-framework-module="" type="module" src="/_furin/devtools/client.js"></script>' +
        '<script data-furin-framework-module="" type="module" src="/_furin/dev/overlay.js"></script>' +
        '<script type="module" src="/_bun/app.js"></script>'
    );

    expect(assets.entryModule).toBe("/_bun/app.js");
    expect(assets.frameworkModules).toEqual([
      "/_furin/devtools/client.js",
      "/_furin/dev/overlay.js",
    ]);
  });

  test("keeps framework modules injected after Bun's application entry", () => {
    const assets = documentAssetsFromTemplate(
      '<script type="module" src="/_bun/app.js" data-bun-dev-server-script></script>' +
        '<script data-furin-framework-module="" type="module" src="/_furin/dev/overlay.js"></script>'
    );

    expect(assets.entryModule).toBe("/_bun/app.js");
    expect(assets.frameworkModules).toEqual(["/_furin/dev/overlay.js"]);
  });

  test("orders the browser event runtime before its framework consumers", () => {
    const assets = documentAssetsFromTemplate(
      '<script data-furin-framework-module="" type="module" src="/_furin/dev/overlay.js"></script>' +
        '<script data-furin-framework-module="" type="module" src="/_furin/events/client.js"></script>'
    );

    expect(assets.frameworkModules).toEqual(["/_furin/events/client.js", "/_furin/dev/overlay.js"]);
  });

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
      fetch() {
        requestCount += 1;
        return new Response("<html>dev-template</html>");
      },
      port: 0,
    });

    try {
      const { origin } = server.url;

      const first = await getDevTemplate(origin);
      const second = await getDevTemplate(origin);

      expect(first).toBe(
        '<script data-furin-framework-module="" type="module" src="/_furin/dev/overlay.js"></script>' +
          '<script data-furin-framework-module="" type="module" src="/_furin/devtools/client.js"></script>' +
          '<script data-furin-framework-module="" type="module" src="/_furin/events/client.js"></script>' +
          "<html>dev-template</html>"
      );
      expect(second).toBe(first);
      // Second call within 1s TTL should hit the cache
      expect(requestCount).toBe(1);
    } finally {
      server.stop(true);
    }
  }, 10_000);

  test("getDevTemplate injects the native DevTools client before application scripts", async () => {
    const server = Bun.serve({
      fetch() {
        return new Response(
          '<html><head></head><body><script type="module" src="/_bun/client/app.js"></script></body></html>'
        );
      },
      port: 0,
    });

    try {
      const html = await getDevTemplate(server.url.origin);
      const browserEventsIndex = html.indexOf(
        '<script data-furin-framework-module="" type="module" src="/_furin/events/client.js"></script>'
      );
      const devtoolsIndex = html.indexOf(
        '<script data-furin-framework-module="" type="module" src="/_furin/devtools/client.js"></script>'
      );
      const applicationIndex = html.indexOf(
        '<script type="module" src="/_bun/client/app.js"></script>'
      );

      expect(browserEventsIndex).toBeGreaterThan(-1);
      expect(browserEventsIndex).toBeLessThan(devtoolsIndex);
      expect(devtoolsIndex).toBeLessThan(applicationIndex);
    } finally {
      server.stop(true);
    }
  }, 10_000);

  test("getDevTemplate throws on failed fetch", async () => {
    const server = Bun.serve({
      fetch() {
        return new Response("boom", { status: 500 });
      },
      port: 0,
    });

    try {
      const { origin } = server.url;
      await expect(getDevTemplate(origin)).rejects.toThrow("/_bun_hmr_entry returned 500");
    } finally {
      server.stop(true);
    }
  }, 10_000);
});

import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { DocumentProvider, HeadContent } from "../../../src/client/document.tsx";
import {
  __resetTemplateState,
  documentAssetsFromTemplate,
  getDevDocumentAssets,
} from "../../../src/server/render/template.ts";
import { installDom, uninstallDom } from "../../support/dom.ts";

const FILTER_SCRIPT_PATTERN = /<script data-furin-extension-error-filter="">([\s\S]*?)<\/script>/;

function renderHead(assets: Awaited<ReturnType<typeof getDevDocumentAssets>>): string {
  return renderToStaticMarkup(
    createElement(
      DocumentProvider,
      { value: { assets, dataJson: undefined, head: undefined, syncJson: undefined } },
      createElement(HeadContent)
    )
  );
}

test("development document hides extension rejections but retains application rejections", async () => {
  const server = Bun.serve({
    fetch: () => new Response("<html><head></head><body></body></html>"),
    port: 0,
  });
  installDom();
  try {
    const assets = await getDevDocumentAssets(server.url.origin);
    const source = renderHead(assets).match(FILTER_SCRIPT_PATTERN)?.[1];
    if (source === undefined) {
      throw new Error("Missing extension error filter in development document");
    }
    new Function("window", source)(window);

    const observed: string[] = [];
    window.addEventListener("unhandledrejection", (event) => {
      observed.push((event.reason as Error).stack ?? "");
    });

    for (const stack of [
      "Error: MetaMask failed\n    at Object.connect (chrome-extension://example/inpage.js:7:1)",
      "Error: App failed\n    at saveBoard (http://localhost:3002/board.js:10:4)\n    at chrome-extension://example/inpage.js:1:1",
    ]) {
      const event = new Event("unhandledrejection", { cancelable: true });
      Object.defineProperty(event, "reason", { value: { stack } });
      window.dispatchEvent(event);
    }

    expect(observed).toEqual([
      "Error: App failed\n    at saveBoard (http://localhost:3002/board.js:10:4)\n    at chrome-extension://example/inpage.js:1:1",
    ]);
    expect(renderHead(documentAssetsFromTemplate("<html></html>"))).not.toContain(
      "data-furin-extension-error-filter"
    );
  } finally {
    server.stop(true);
    __resetTemplateState();
    await uninstallDom();
  }
});

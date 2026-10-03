import { expect, test } from "bun:test";
import "../../setup/global.ts";
import {
  DocumentProvider,
  type DocumentState,
  HeadContent,
} from "../../../src/client/document.tsx";
import { installDom, uninstallDom } from "../../support/dom.ts";

test.serial(
  "inserting head descriptors preserves existing nodes and identical duplicates",
  async () => {
    installDom();
    const { act } = await import("react");
    const { createRoot } = await import("react-dom/client");
    const state: DocumentState = {
      assets: {
        buildId: undefined,
        entryModule: undefined,
        faviconHref: undefined,
        frameworkModules: [],
        staticMode: false,
        stylesheets: [],
      },
      dataJson: undefined,
      head: {
        meta: [{ name: "description", content: "existing" }],
        links: [{ rel: "alternate", href: "/existing" }],
        scripts: [{ children: "window.existing = true;", "data-test": "existing" }],
        styles: [{ children: ".existing {}" }, { children: ".existing {}" }],
      },
      syncJson: undefined,
    };
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    const render = (value: DocumentState) =>
      act(() =>
        root.render(
          <DocumentProvider value={value}>
            <HeadContent />
          </DocumentProvider>
        )
      );
    try {
      await render(state);
      const meta = document.querySelector('meta[name="description"]');
      const link = document.querySelector('link[href="/existing"]');
      const script = document.querySelector('script[data-test="existing"]');
      const styles = Array.from(document.querySelectorAll("style"));
      expect(styles).toHaveLength(2);
      await render({
        ...state,
        head: {
          meta: [{ name: "author", content: "new" }, ...(state.head?.meta ?? [])],
          links: [{ rel: "alternate", href: "/new" }, ...(state.head?.links ?? [])],
          scripts: [
            { children: "window.new = true;", "data-test": "new" },
            ...(state.head?.scripts ?? []),
          ],
          styles: [{ children: ".new {}" }, ...(state.head?.styles ?? [])],
        },
      });
      expect(document.querySelector('meta[name="description"]')).toBe(meta);
      expect(document.querySelector('link[href="/existing"]')).toBe(link);
      expect(document.querySelector('script[data-test="existing"]')).toBe(script);
      expect(Array.from(document.querySelectorAll("style")).slice(1)).toEqual(styles);
    } finally {
      await act(() => root.unmount());
      container.remove();
      await uninstallDom();
    }
  }
);

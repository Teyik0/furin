import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { SyncDemo } from "../src/components/landing/sync-demo";

describe("SyncDemo", () => {
  test("server-renders the settled state: Alice moved the card, Bob's tab followed", () => {
    const html = renderToStaticMarkup(createElement(SyncDemo));
    expect(html).toContain("⚡ optimistic");
    expect(html).toContain("synced");
    // the moving card sits in the "In progress" column (index 1) in both tabs
    expect(html.match(/sync-card--mover[^>]*--c:1/g)?.length).toBe(2);
  });
});

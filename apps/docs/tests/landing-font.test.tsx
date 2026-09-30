import { describe, expect, test } from "bun:test";
import { RouterContext, SSR_FALLBACK_ROUTER } from "@teyik0/furin/link";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { LandingFont } from "../src/components/landing/landing-font";

function render(basePath: string) {
  return renderToString(
    createElement(
      RouterContext.Provider,
      { value: { ...SSR_FALLBACK_ROUTER, basePath } },
      createElement(LandingFont)
    )
  );
}

describe("LandingFont", () => {
  test("preloads the Geist woff2 from the static export's base path", () => {
    const html = render("/furin");
    expect(html).toContain('rel="preload"');
    expect(html).toContain('as="font"');
    expect(html).toContain('href="/furin/fonts/geist-latin-wght-normal.woff2"');
  });

  test("declares the face against the same URL so the preload is reused", () => {
    const html = render("/furin");
    expect(html).toContain('font-family:"Geist Variable"');
    expect(html).toContain('url("/furin/fonts/geist-latin-wght-normal.woff2")');
  });

  test("falls back to the dev public mount when there is no base path", () => {
    expect(render("")).toContain('href="/public/fonts/geist-latin-wght-normal.woff2"');
  });
});

import { RouterContext } from "@teyik0/furin/link";
import { use } from "react";
import { preload } from "react-dom";

const LATIN_RANGE =
  "U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD";

/**
 * Landing-only display font (latin variable Geist, OFL — see public/fonts/Geist-OFL.txt).
 * Declared here instead of globals.css so the shared stylesheet stays font-free for every
 * docs page, and preloaded so the fetch starts in parallel with that stylesheet.
 * Same URL prefix rule as RootLayout's logo: basePath in the static export, /public in dev.
 */
export function LandingFont() {
  const router = use(RouterContext);
  const href = `${router?.basePath || "/public"}/fonts/geist-latin-wght-normal.woff2`;
  preload(href, { as: "font", crossOrigin: "anonymous", type: "font/woff2" });
  return (
    <style>
      {`@font-face{font-family:"Geist Variable";font-style:normal;font-display:swap;font-weight:100 900;src:url("${href}") format("woff2-variations");unicode-range:${LATIN_RANGE}}`}
    </style>
  );
}

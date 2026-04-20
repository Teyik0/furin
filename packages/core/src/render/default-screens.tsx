/**
 * Built-in fallback UIs for the framework's default 404 and 500 pages.
 *
 * Design constraints:
 *   1. INLINE STYLES ONLY. We can't assume the user has Tailwind / a CSS
 *      reset / any stylesheet at all — the page must look identical whether
 *      this renders before or after the user's stylesheets.
 *   2. ZERO RUNTIME DEPENDENCIES. These render server-side as static HTML and
 *      hydrate without needing any JS to look right. Only the "Try again"
 *      button needs hydration to function (it falls back to a no-op on SSR).
 *   3. NO EXTERNAL FONTS. Use the system monospace + sans stacks so the
 *      typography is consistent without a network round-trip.
 *
 * Visual language: terminal/dev-tool aesthetic — black background, faint
 * grid, monospace for technical bits, no chrome. Hierarchy is carried by
 * typography + spacing alone so the screen feels at-home in any project
 * regardless of brand.
 */
import type { CSSProperties, ReactNode } from "react";
import { Link } from "../link";

const FONT_SANS =
  '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';
const FONT_MONO =
  'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace';

const COLOR_BG = "#000000";
const COLOR_TEXT = "#ffffff";
const COLOR_TEXT_DIM = "rgba(255, 255, 255, 0.7)";
const COLOR_TEXT_MUTED = "rgba(255, 255, 255, 0.45)";
const COLOR_GRID = "rgba(255, 255, 255, 0.04)";
const COLOR_BRACKET = "rgba(255, 255, 255, 0.55)";
const COLOR_DANGER_DIM = "rgba(239, 68, 68, 0.6)";

const PAGE_STYLE: CSSProperties = {
  alignItems: "center",
  backgroundColor: COLOR_BG,
  // Faint grid: two repeating gradients crossed for the lattice look.
  backgroundImage: `
    linear-gradient(${COLOR_GRID} 1px, transparent 1px),
    linear-gradient(90deg, ${COLOR_GRID} 1px, transparent 1px)
  `,
  backgroundSize: "32px 32px, 32px 32px",
  boxSizing: "border-box",
  color: COLOR_TEXT,
  display: "flex",
  fontFamily: FONT_SANS,
  fontSize: "16px",
  justifyContent: "center",
  lineHeight: 1.5,
  margin: 0,
  minHeight: "100vh",
  padding: "32px",
  width: "100%",
};

const FRAME_STYLE: CSSProperties = {
  boxSizing: "border-box",
  maxWidth: "880px",
  position: "relative",
  width: "100%",
};

const BRACKET_BASE: CSSProperties = {
  height: "40px",
  position: "absolute",
  width: "40px",
};

function CornerBracket({ corner }: { corner: "tl" | "tr" | "bl" | "br" }) {
  // L-shaped bracket built from two 2px borders on the inside corners.
  const top = corner === "tl" || corner === "tr";
  const left = corner === "tl" || corner === "bl";
  const style: CSSProperties = {
    ...BRACKET_BASE,
    [top ? "top" : "bottom"]: 0,
    [left ? "left" : "right"]: 0,
    [`border${top ? "Top" : "Bottom"}`]: `2px solid ${COLOR_BRACKET}`,
    [`border${left ? "Left" : "Right"}`]: `2px solid ${COLOR_BRACKET}`,
  };
  return <span aria-hidden="true" style={style} />;
}

const CARD_STYLE: CSSProperties = {
  boxSizing: "border-box",
  margin: "0 auto",
  maxWidth: "640px",
  padding: "64px 24px",
  textAlign: "center",
};

// Borders are deliberately absent on every element except the danger-coloured
// error badge. The visual hierarchy is carried by typography + spacing alone.

const BADGE_STYLE: CSSProperties = {
  border: `1px solid ${COLOR_DANGER_DIM}`,
  color: COLOR_TEXT,
  display: "inline-block",
  fontFamily: FONT_SANS,
  fontSize: "32px",
  fontWeight: 600,
  letterSpacing: "0.08em",
  marginBottom: "16px",
  padding: "12px 36px",
};

// 404 isn't an "error" in the same sense as a 500, so we drop the danger ring
// entirely and let the typography stand on its own.
const NOT_FOUND_BADGE_STYLE: CSSProperties = {
  ...BADGE_STYLE,
  border: 0,
  padding: 0,
};

const HEADING_STYLE: CSSProperties = {
  color: COLOR_TEXT,
  fontFamily: FONT_SANS,
  fontSize: "24px",
  fontWeight: 600,
  margin: "0 0 24px 0",
};

const CODE_BOX_STYLE: CSSProperties = {
  color: COLOR_TEXT_DIM,
  display: "inline-block",
  fontFamily: FONT_MONO,
  fontSize: "13px",
  letterSpacing: "0.02em",
  margin: "0 0 32px 0",
  padding: "8px 0",
};

const CODE_LABEL_STYLE: CSSProperties = {
  color: COLOR_TEXT_MUTED,
  marginRight: "10px",
  textTransform: "uppercase",
};

const DESCRIPTION_WRAPPER_STYLE: CSSProperties = {
  color: COLOR_TEXT_DIM,
  fontSize: "15px",
  margin: "0 auto 40px auto",
  maxWidth: "440px",
  padding: 0,
  textAlign: "center",
};

const ACTIONS_STYLE: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  gap: "16px",
  justifyContent: "center",
};

const BUTTON_BASE: CSSProperties = {
  border: 0,
  cursor: "pointer",
  display: "inline-flex",
  fontFamily: FONT_SANS,
  fontSize: "14px",
  fontWeight: 500,
  lineHeight: 1,
  minWidth: "120px",
  padding: "10px 16px",
  textAlign: "center",
  textDecoration: "none",
  transition: "background-color 120ms ease, color 120ms ease, opacity 120ms ease",
  appearance: "none",
  alignItems: "center",
  justifyContent: "center",
  boxSizing: "border-box",
};

// Outlined buttons: thin neutral border, no fill — discreet enough to blend
// with the dark canvas while still reading as a clickable affordance.
const BUTTON_PRIMARY: CSSProperties = {
  ...BUTTON_BASE,
  backgroundColor: COLOR_TEXT,
  border: `1px solid ${COLOR_TEXT}`,
  boxShadow: "0 10px 24px rgba(255, 255, 255, 0.08)",
  color: COLOR_BG,
  fontWeight: 600,
};

const BUTTON_SECONDARY: CSSProperties = {
  ...BUTTON_BASE,
  backgroundColor: "transparent",
  border: "1px solid rgba(255, 255, 255, 0.22)",
  color: COLOR_TEXT_DIM,
};

// Hairline rule under the badge — the only neutral chrome line we keep, just
// to anchor the badge visually without competing with it.
const DIVIDER_STYLE: CSSProperties = {
  backgroundColor: "rgba(255, 255, 255, 0.12)",
  border: 0,
  height: "1px",
  margin: "0 0 40px 0",
  width: "100%",
};

interface ScreenFrameProps {
  badge: ReactNode;
  children: ReactNode;
}

/**
 * Reset the host page's chrome so the dark background covers the entire
 * viewport — including the area behind the scrollbar and the default 8px
 * margin browsers apply to <body>. We can't do this with inline styles
 * alone (they only target the element they're on, not html/body), and we
 * can't ship a CSS file (the user might not have Tailwind / a bundler
 * step). React 19 hoists <style> nodes to <head> automatically, so this
 * works in both SSR and hydration without a flash of white chrome.
 *
 * `overscroll-behavior: none` also prevents the white "bounce" area on
 * macOS Safari / Chrome when scrolling past the viewport edges.
 */
const RESET_CSS = `
html, body {
  margin: 0;
  padding: 0;
  background-color: ${COLOR_BG};
  overscroll-behavior: none;
}
`;

function ScreenFrame({ badge, children }: ScreenFrameProps) {
  return (
    <div style={PAGE_STYLE}>
      {/* biome-ignore lint/security/noDangerouslySetInnerHtml: literal CSS string, no user input */}
      <style dangerouslySetInnerHTML={{ __html: RESET_CSS }} />
      <div style={FRAME_STYLE}>
        <CornerBracket corner="tl" />
        <CornerBracket corner="tr" />
        <CornerBracket corner="bl" />
        <CornerBracket corner="br" />
        <div style={CARD_STYLE}>
          {badge}
          <hr style={DIVIDER_STYLE} />
          {children}
        </div>
      </div>
    </div>
  );
}

interface DefaultErrorScreenProps {
  digest: string;
  message: string;
  reset: () => void;
}

export function DefaultErrorScreen({ message, digest, reset }: DefaultErrorScreenProps) {
  return (
    <ScreenFrame badge={<div style={BADGE_STYLE}>500 — ERROR</div>}>
      <h1 style={HEADING_STYLE}>Something went wrong</h1>
      <div style={CODE_BOX_STYLE}>
        <span style={CODE_LABEL_STYLE}>CODE:</span>
        <span>{digest}</span>
      </div>
      <p style={DESCRIPTION_WRAPPER_STYLE}>
        {message
          ? message
          : "We encountered an unexpected error. Please try again or return to the home page."}
      </p>
      <div style={ACTIONS_STYLE}>
        <Link style={BUTTON_PRIMARY} to="/">
          Go Home
        </Link>
        <button onClick={reset} style={BUTTON_SECONDARY} type="button">
          Try again
        </button>
      </div>
    </ScreenFrame>
  );
}

interface DefaultNotFoundScreenProps {
  message: string | undefined;
}

export function DefaultNotFoundScreen({ message }: DefaultNotFoundScreenProps) {
  return (
    <ScreenFrame badge={<div style={NOT_FOUND_BADGE_STYLE}>404 — NOT FOUND</div>}>
      <h1 style={HEADING_STYLE}>This page does not exist</h1>
      <p style={DESCRIPTION_WRAPPER_STYLE}>
        {message
          ? message
          : "The page you are looking for could not be found. It may have been moved or removed."}
      </p>
      <div style={ACTIONS_STYLE}>
        <Link style={BUTTON_PRIMARY} to="/">
          Go Home
        </Link>
      </div>
    </ScreenFrame>
  );
}

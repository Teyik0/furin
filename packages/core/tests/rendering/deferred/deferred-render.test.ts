import { describe, expect, test } from "bun:test";
import { toCrossJSON } from "seroval";
import { buildDeferredResolution } from "../../../src/server/render/assemble.ts";

const SCRIPT_OPEN_RE = /^<script[^>]*>/;
const SCRIPT_CLOSE_RE = /<\/script>$/;

describe("buildDeferredResolution()", () => {
  // ── XSS hardening ─────────────────────────────────────────────────────────
  test("XSS: a value containing </script> is escaped — no tag break-out", () => {
    const evil = "</script><script>window.pwned=1</script>";
    const chunk = toCrossJSON(evil);
    const script = buildDeferredResolution("payload", chunk, "resolve");
    // The literal "</script>" sequence must NOT appear unescaped inside the
    // generated inline <script> body. safeJson() rewrites "</" to "<\\/".
    const innerBody = script.replace(SCRIPT_OPEN_RE, "").replace(SCRIPT_CLOSE_RE, "");
    expect(innerBody).not.toContain("</script>");
  });
});

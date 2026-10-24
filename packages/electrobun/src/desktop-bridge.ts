export type OpenBrowserResult =
  | { ok: true }
  | { ok: false; reason: "unavailable" | "invalid-url" | "open-failed" };

export type DesktopRequest = { id: string; type: "furin:desktop" } & (
  | { command: "available" }
  | { command: "open-browser"; url: string }
);

export const DESKTOP_RESPONSE = "furin:desktop-result";

function isDesktopRequest(value: unknown): value is DesktopRequest {
  return (
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    value.type === "furin:desktop" &&
    "id" in value &&
    typeof value.id === "string" &&
    value.id.length <= 128 &&
    "command" in value &&
    (value.command === "available" ||
      (value.command === "open-browser" && "url" in value && typeof value.url === "string"))
  );
}

export function parseDesktopRequest(detail: unknown): DesktopRequest | undefined {
  try {
    const value: unknown = typeof detail === "string" ? JSON.parse(detail) : detail;
    return isDesktopRequest(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

export function getBrowserUrl(value: string, base: string | undefined): string | undefined {
  try {
    const url = new URL(value, base);
    if (["https:", "http:", "mailto:"].includes(url.protocol) && !url.username && !url.password) {
      return url.href;
    }
  } catch {
    // Invalid URLs cannot grant native navigation capabilities.
  }
}

import { timingSafeEqual } from "node:crypto";
import type { DesktopSession } from "./runtime";

const PREFIX = "/.furin/desktop/";
const LIFETIME = 60_000;
const LOOPBACK = /^(?:127\.\d{1,3}\.\d{1,3}\.\d{1,3}|::1|::ffff:127\.\d{1,3}\.\d{1,3}\.\d{1,3})$/u;
const FORWARDED = ["forwarded", "x-forwarded-for", "x-forwarded-host", "x-forwarded-proto"];

function sign(key: string, payload: string): string {
  return new Bun.CryptoHasher("sha256", key).update(payload).digest("base64url");
}

/**
 * Development window capability, minted synchronously by the native shell with the key the
 * backend shares over its authenticated channel. The backend redeems it once on its own origin.
 */
export function mintWindowUrl(
  key: string,
  origin: string,
  destination: string | undefined
): string {
  const target = new URL(destination ?? "/", origin);
  if (target.origin !== origin || target.username || target.password) {
    throw new Error("Desktop window destination must use the app origin.");
  }
  const payload = Buffer.from(
    JSON.stringify({
      path: `${target.pathname}${target.search}${target.hash}`,
      issued: Date.now(),
      nonce: crypto.randomUUID(),
    })
  ).toString("base64url");
  return `${origin}${PREFIX}${payload}.${sign(key, payload)}`;
}

export function redeemWindowUrl(
  key: string,
  spent: Map<string, number>,
  session: DesktopSession,
  origin: string,
  request: Request,
  peerAddress: string | undefined
): Response | undefined {
  const url = new URL(request.url);
  if (!url.pathname.startsWith(PREFIX)) {
    return;
  }
  const [payload = "", signature = ""] = url.pathname.slice(PREFIX.length).split(".");
  const expected = Buffer.from(sign(key, payload));
  const received = Buffer.from(signature);
  if (
    request.method !== "GET" ||
    url.origin !== origin ||
    url.search !== "" ||
    !peerAddress ||
    !LOOPBACK.test(peerAddress) ||
    FORWARDED.some((name) => request.headers.has(name)) ||
    (request.headers.has("origin") && request.headers.get("origin") !== origin) ||
    request.headers.get("sec-fetch-site") === "cross-site" ||
    (request.headers.has("referer") && !request.headers.get("referer")?.startsWith(`${origin}/`)) ||
    expected.length !== received.length ||
    !timingSafeEqual(expected, received)
  ) {
    return new Response("Forbidden", { status: 403 });
  }
  const token: { path: string; issued: number; nonce: string } = JSON.parse(
    Buffer.from(payload, "base64url").toString()
  );
  if (spent.has(token.nonce) || Date.now() - token.issued > LIFETIME) {
    return new Response("Gone", { status: 410, headers: { "cache-control": "no-store" } });
  }
  for (const [nonce, issued] of spent) {
    // Expired tokens are rejected by age, so their nonces no longer need tracking.
    if (Date.now() - issued > LIFETIME) {
      spent.delete(nonce);
    }
  }
  spent.set(token.nonce, token.issued);
  return new Response(null, {
    status: 303,
    headers: {
      location: new URL(token.path, origin).href,
      "set-cookie": `${session.name}=${session.value}; HttpOnly; SameSite=Strict; Path=/${origin.startsWith("https:") ? "; Secure" : ""}`,
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
    },
  });
}

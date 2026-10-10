import { expect, test } from "bun:test";
import { createSessionGuard, getExternalUrl } from "../src/runtime";

test("session cookie does not authorize another loopback port's browser requests", () => {
  const origin = "http://127.0.0.1:12345";
  const guard = createSessionGuard({ name: "session", value: "secret" }, () => origin);
  const denied: { [key: string]: string }[] = [
    { referer: "http://127.0.0.1:12346/page" },
    { "sec-fetch-site": "same-site" },
    { referer: "http://127.0.0.1:12346/page", "sec-fetch-site": "same-site" },
  ];
  for (const headers of denied) {
    expect(
      guard(new Request(`${origin}/api`, { headers: { cookie: "session=secret", ...headers } }))
        ?.status
    ).toBe(403);
  }
});

test("same-origin browser and headerless capability requests remain authorized", () => {
  const origin = "http://127.0.0.1:12345";
  const guard = createSessionGuard({ name: "session", value: "secret" }, () => origin);
  const allowed: { [key: string]: string }[] = [
    {},
    { referer: `${origin}/page`, "sec-fetch-site": "same-origin" },
    { origin, upgrade: "websocket" },
    { "sec-fetch-site": "none", "sec-fetch-mode": "navigate", "sec-fetch-dest": "document" },
  ];
  for (const headers of allowed) {
    expect(
      guard(new Request(`${origin}/`, { headers: { cookie: "session=secret", ...headers } }))
    ).toBeUndefined();
  }
});

test("SDK native JSON navigation and popup events open only safe external URLs", () => {
  const origin = "http://127.0.0.1:12345";
  const bootstrapOrigin = "http://127.0.0.1:12346";
  const localOrigins = [origin, bootstrapOrigin];
  expect(getExternalUrl('{"url":"https://example.com","allowed":false}', localOrigins)).toBe(
    "https://example.com/"
  );
  expect(getExternalUrl({ url: "mailto:test@example.com" }, localOrigins)).toBe(
    "mailto:test@example.com"
  );
  expect(getExternalUrl({ url: `${origin}/api` }, localOrigins)).toBeUndefined();
  expect(
    getExternalUrl(
      JSON.stringify({ url: `${bootstrapOrigin}/bootstrap-secret`, allowed: true }),
      localOrigins
    )
  ).toBeUndefined();
  expect(getExternalUrl({ url: "file:///etc/passwd" }, localOrigins)).toBeUndefined();
  expect(getExternalUrl("javascript:alert(1)", localOrigins)).toBeUndefined();
});

test("application session guard has no credential bootstrap route and rejects other origins", () => {
  const guard = createSessionGuard(
    { name: "instance_cookie", value: "secret" },
    () => "http://127.0.0.1:12345"
  );
  expect(guard(new Request("http://127.0.0.1:12345/_furin_desktop/secret"))?.status).toBe(403);
  expect(guard(new Request("http://127.0.0.1:12345/api"))?.status).toBe(403);
  const cookie = "instance_cookie=secret";
  expect(guard(new Request("http://127.0.0.1:12345/api", { headers: { cookie } }))).toBeUndefined();
  expect(
    guard(
      new Request("http://127.0.0.1:12345/api", {
        headers: { cookie, origin: "https://evil.example" },
      })
    )?.status
  ).toBe(403);
});

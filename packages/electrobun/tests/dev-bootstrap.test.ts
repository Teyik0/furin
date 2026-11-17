import { expect, setSystemTime, test } from "bun:test";
import { mintWindowUrl, redeemWindowUrl } from "../src/dev-bootstrap";

const origin = "http://127.0.0.1:4100";
const session = { name: "furin_desktop", value: "secret" };

function redeem(url: string, headers: { [name: string]: string }, spent: Map<string, number>) {
  return redeemWindowUrl("key", spent, session, origin, new Request(url, { headers }), "127.0.0.1");
}

test("a development window URL keeps the destination fragment", () => {
  const response = redeem(mintWindowUrl("key", origin, "/docs?tab=1#install", true), {}, new Map());
  expect(response?.status).toBe(303);
  expect(response?.headers.get("location")).toBe(`${origin}/docs?tab=1#install`);
});

test.each([
  ["origin", "https://evil.test"],
  ["referer", "https://evil.test/page"],
])("a development window URL rejects a foreign %s without Sec-Fetch-Site", (name, value) => {
  expect(
    redeem(mintWindowUrl("key", origin, "/", true), { [name]: value }, new Map())?.status
  ).toBe(403);
});

test("a development window URL redeems once", () => {
  const spent = new Map<string, number>();
  const url = mintWindowUrl("key", origin, "/", true);
  expect(redeem(url, {}, spent)?.status).toBe(303);
  expect(redeem(url, {}, spent)?.status).toBe(410);
});

test("a development window URL expires after a minute", () => {
  const url = mintWindowUrl("key", origin, "/", true);
  setSystemTime(Date.now() + 61_000);
  try {
    expect(redeem(url, {}, new Map())?.status).toBe(410);
  } finally {
    setSystemTime();
  }
});

test("a non-expiring browser link redeems once, even long after it was printed", () => {
  const spent = new Map<string, number>();
  const url = mintWindowUrl("key", origin, "/", false);
  setSystemTime(Date.now() + 3_600_000);
  try {
    expect(redeem(url, {}, spent)?.status).toBe(303);
    // Pruning expired nonces must not make the link redeemable again.
    redeem(mintWindowUrl("key", origin, "/", true), {}, spent);
    expect(redeem(url, {}, spent)?.status).toBe(410);
  } finally {
    setSystemTime();
  }
});

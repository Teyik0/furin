import { expect, test } from "bun:test";
import { createDeferredRouteFrameStream } from "../../../src/server/render/route-frame-transport.ts";

test("deferred route frames stream as each promise settles", async () => {
  let resolveFast: ((value: string) => void) | undefined;
  const slow = new Promise<string>(() => {
    // Intentionally never settles.
  });
  const fast = new Promise<string>((resolve) => {
    resolveFast = resolve;
  });
  const reader = createDeferredRouteFrameStream({}, { fast, slow }).getReader();

  await reader.read();
  resolveFast?.("ready");

  const frame = await reader.read();
  expect(new TextDecoder().decode(frame.value)).toContain('"key":"fast"');
});

test("deferred route frames reject a stream larger than the parser limit", async () => {
  const deferred = Object.fromEntries(
    Array.from({ length: 17 }, (_, index) => [
      `part-${index}`,
      Promise.resolve("x".repeat(512 * 1024)),
    ])
  );

  const response = new Response(createDeferredRouteFrameStream({}, deferred));

  await expect(response.arrayBuffer()).rejects.toThrow("route frame stream exceeds");
});

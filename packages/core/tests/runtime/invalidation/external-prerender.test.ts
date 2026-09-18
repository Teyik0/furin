import { describe, expect, test } from "bun:test";
import {
  isExternalPrerenderRequest,
  markExternalPrerenderRequest,
} from "../../../src/server/external-prerender.ts";

describe("external prerender request identity", () => {
  test("cannot be forged with an HTTP header", () => {
    const forged = new Request("http://localhost/isr", {
      headers: { "x-furin-external-prerender": "1" },
    });

    expect(isExternalPrerenderRequest(forged)).toBe(false);
    expect(isExternalPrerenderRequest(markExternalPrerenderRequest(forged))).toBe(true);
  });
});

import { expect, test } from "bun:test";
import { defineDesktopConfig } from "../src/config";

test("desktop config preserves the public single-window contract", () => {
  const config = {
    app: { name: "Relay", identifier: "local.furin.relay" },
    window: { width: 960, height: 720 },
  };
  expect(defineDesktopConfig(config)).toEqual(config);
});

test("desktop config rejects invalid dimensions and identifiers", () => {
  expect(() =>
    defineDesktopConfig({
      app: { name: "Relay", identifier: "../relay" },
      window: { width: 960, height: 720 },
    })
  ).toThrow("identifier");
  expect(() =>
    defineDesktopConfig({
      app: { name: "Relay", identifier: "local.furin.relay" },
      window: { width: 0, height: 720 },
    })
  ).toThrow("width");
});

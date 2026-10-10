import { expect, test } from "bun:test";
import { defineDesktopConfig, validateDesktopConfig } from "../src/config";

test("desktop versions accept prerelease and build metadata together", () => {
  const config = {
    app: {
      name: "Relay",
      identifier: "local.furin.relay",
      version: "1.2.3-beta.1+build.42",
    },
    window: { width: 960, height: 720 },
  };
  expect(defineDesktopConfig(config)).toEqual(config);
});

test("desktop config rejects dot package segments", () => {
  for (const name of [".", "..", "@scope/.", "@scope/..", "@./name", "@../name"]) {
    expect(() =>
      defineDesktopConfig({
        app: { name: "Relay", identifier: "local.furin.relay" },
        window: { width: 960, height: 720 },
        external: [name],
      })
    ).toThrow("package names");
  }
});

test("desktop config preserves the public single-window contract", () => {
  const config = {
    app: { name: "Relay", identifier: "local.furin.relay" },
    window: { width: 960, height: 720 },
    external: ["@fixture/package", "alias-a", "package.name", "_private"],
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

test("SDK additions reject malformed schemes, copy paths and signing flags", () => {
  for (const sdk of [
    { app: { urlSchemes: "tofu" } },
    { app: { fileAssociations: [null] } },
    { app: { fileAssociations: [{ ext: "torrent", name: "Torrent" }] } },
    { app: { fileAssociations: [{ ext: ["torrent"], name: 123 }] } },
    { app: { fileAssociations: [{ ext: ["torrent"], name: "Torrent", icon: 123 }] } },
    { app: { fileAssociations: [{ ext: ["torrent"], name: "Torrent", role: "invalid" }] } },
    { build: { copy: { source: 123 } } },
    { build: { mac: { codesign: "yes" } } },
    { release: { baseUrl: "not-a-url" } },
  ]) {
    expect(() =>
      validateDesktopConfig({
        app: { name: "Tofu", identifier: "app.tofu.dev" },
        window: { width: 1400, height: 940 },
        sdk,
      })
    ).toThrow("sdk");
  }
});

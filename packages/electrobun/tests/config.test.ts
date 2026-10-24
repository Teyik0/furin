import { expect, test } from "bun:test";
import { defineDesktopConfig, validateDesktopConfig } from "../src/config";

test("desktop versions accept prerelease and build metadata together", () => {
  const config = {
    app: {
      name: "Relay",
      identifier: "local.furin.relay",
      version: "1.2.3-beta.1+build.42",
    },
  };
  expect(defineDesktopConfig(config)).toEqual(config);
});

test("desktop config rejects dot package segments", () => {
  for (const name of [".", "..", "@scope/.", "@scope/..", "@./name", "@../name"]) {
    expect(() =>
      defineDesktopConfig({
        app: { name: "Relay", identifier: "local.furin.relay" },
        external: [name],
      })
    ).toThrow("package names");
  }
});

test("desktop config preserves the SDK packaging without a window declaration", () => {
  const config = {
    app: { name: "Relay", identifier: "local.furin.relay" },
    external: ["@fixture/package", "alias-a", "package.name", "_private"],
  };
  expect(defineDesktopConfig(config)).toEqual(config);
});

test("desktop config rejects invalid identifiers", () => {
  expect(() =>
    defineDesktopConfig({
      app: { name: "Relay", identifier: "../relay" },
    })
  ).toThrow("identifier");
});

test("desktop configuration rejects unsupported main processes and empty entrypoints", () => {
  const config = {
    app: { name: "Relay", identifier: "local.furin.relay" },
  };
  expect(() => validateDesktopConfig({ ...config, build: { mainProcess: "cottontail" } })).toThrow(
    'must be "bun"'
  );
  expect(() => validateDesktopConfig({ ...config, build: { bun: { entrypoint: "" } } })).toThrow(
    "nonempty path"
  );
});

test("SDK additions reject malformed schemes, copy paths and signing flags", () => {
  for (const settings of [
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
        ...settings,
      })
    ).toThrow();
  }
});

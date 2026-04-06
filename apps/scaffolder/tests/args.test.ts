import { describe, expect, it } from "bun:test";
import { parseArgs } from "../src/args";

describe("parseArgs", () => {
  it("returns default ParsedArgs when no arguments", () => {
    const result = parseArgs([]);
    expect(result.targetDir).toBeNull();
    expect(result.template).toBeNull();
    expect(result.help).toBe(false);
    expect(result.version).toBe(false);
    expect(result.yes).toBe(false);
    expect(result.install).toBe(true);
  });

  it("parses positional target directory", () => {
    const result = parseArgs(["my-app"]);
    expect(result.targetDir).toBe("my-app");
  });

  it("parses --template simple", () => {
    const result = parseArgs(["my-app", "--template", "simple"]);
    expect(result.template).toBe("simple");
  });

  it("parses --template full", () => {
    const result = parseArgs(["my-app", "--template", "full"]);
    expect(result.template).toBe("full");
  });

  it("parses -t shorthand for template", () => {
    const result = parseArgs(["my-app", "-t", "full"]);
    expect(result.template).toBe("full");
  });

  it("parses --template=simple inline syntax", () => {
    const result = parseArgs(["--template=simple"]);
    expect(result.template).toBe("simple");
  });

  it("parses --help flag", () => {
    const result = parseArgs(["--help"]);
    expect(result.help).toBe(true);
  });

  it("parses -h shorthand for help", () => {
    const result = parseArgs(["-h"]);
    expect(result.help).toBe(true);
  });

  it("parses --version flag", () => {
    const result = parseArgs(["--version"]);
    expect(result.version).toBe(true);
  });

  it("parses -v shorthand for version", () => {
    const result = parseArgs(["-v"]);
    expect(result.version).toBe(true);
  });

  it("parses --no-install flag", () => {
    const result = parseArgs(["my-app", "--no-install"]);
    expect(result.install).toBe(false);
  });

  it("parses --yes flag", () => {
    const result = parseArgs(["my-app", "--yes"]);
    expect(result.yes).toBe(true);
  });

  it("throws on unknown flags", () => {
    expect(() => parseArgs(["my-app", "--unknown-flag"])).toThrow();
  });

  it("throws when two positional args provided", () => {
    expect(() => parseArgs(["my-app", "other-arg"])).toThrow();
  });

  it("throws when --yes used without target dir", () => {
    expect(() => parseArgs(["--yes"])).toThrow();
  });

  it("does not confuse --template value as targetDir", () => {
    const result = parseArgs(["--template", "simple"]);
    expect(result.targetDir).toBeNull();
    expect(result.template).toBe("simple");
  });

  it("throws on invalid template name", () => {
    expect(() => parseArgs(["--template", "unknown"])).toThrow();
  });
});

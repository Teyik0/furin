import { describe, expect, test } from "bun:test";
import { parseArgs } from "../src/args.ts";

describe("parseArgs", () => {
  test("defaults template to null so CLI can decide the fallback", () => {
    const result = parseArgs(["my-app"]);

    expect(result.targetDir).toBe("my-app");
    expect(result.template).toBeNull();
    expect(result.yes).toBe(false);
  });

  test("parses template and yes flags", () => {
    const result = parseArgs(["my-app", "--template", "shadcn", "--yes"]);

    expect(result.targetDir).toBe("my-app");
    expect(result.template).toBe("shadcn");
    expect(result.yes).toBe(true);
  });

  test("rejects invalid template values", () => {
    expect(() => parseArgs(["my-app", "--template", "wat"])).toThrow('Invalid template "wat"');
  });

  test("rejects --yes without a target directory", () => {
    expect(() => parseArgs(["--yes"])).toThrow("Target directory is required when using --yes");
  });
});

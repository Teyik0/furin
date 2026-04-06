import { describe, expect, it } from "bun:test";
import {
  normalizePackageName,
  toCamelCase,
  toKebabCase,
  toPascalCase,
} from "../src/engine/helpers";

describe("toKebabCase", () => {
  it("lowercases and hyphenates spaces", () => {
    expect(toKebabCase("My App")).toBe("my-app");
  });

  it("handles camelCase input", () => {
    expect(toKebabCase("myApp")).toBe("my-app");
  });

  it("handles PascalCase input", () => {
    expect(toKebabCase("MyApp")).toBe("my-app");
  });

  it("already kebab-case is idempotent", () => {
    expect(toKebabCase("my-app")).toBe("my-app");
  });

  it("handles multiple spaces", () => {
    expect(toKebabCase("My  Cool  App")).toBe("my-cool-app");
  });

  it("strips leading/trailing hyphens", () => {
    expect(toKebabCase("  my app  ")).toBe("my-app");
  });

  it("handles underscores", () => {
    expect(toKebabCase("my_app")).toBe("my-app");
  });

  it("handles numbers", () => {
    expect(toKebabCase("app2024")).toBe("app2024");
  });
});

describe("toPascalCase", () => {
  it("capitalises each word", () => {
    expect(toPascalCase("my app")).toBe("MyApp");
  });

  it("handles kebab-case input", () => {
    expect(toPascalCase("my-app")).toBe("MyApp");
  });

  it("handles already PascalCase", () => {
    expect(toPascalCase("MyApp")).toBe("MyApp");
  });

  it("handles underscores", () => {
    expect(toPascalCase("my_app")).toBe("MyApp");
  });

  it("handles single word", () => {
    expect(toPascalCase("app")).toBe("App");
  });

  it("handles numbers in segments", () => {
    expect(toPascalCase("my-app-2")).toBe("MyApp2");
  });
});

describe("toCamelCase", () => {
  it("lowercases first word and capitalises subsequent words", () => {
    expect(toCamelCase("my app")).toBe("myApp");
  });

  it("handles kebab-case input", () => {
    expect(toCamelCase("my-app")).toBe("myApp");
  });

  it("already camelCase is idempotent", () => {
    expect(toCamelCase("myApp")).toBe("myApp");
  });

  it("handles single word", () => {
    expect(toCamelCase("app")).toBe("app");
  });
});

describe("normalizePackageName", () => {
  it("converts to valid npm package name", () => {
    expect(normalizePackageName("My App")).toBe("my-app");
  });

  it("handles kebab-case input", () => {
    expect(normalizePackageName("my-app")).toBe("my-app");
  });

  it("handles PascalCase input", () => {
    expect(normalizePackageName("MyApp")).toBe("my-app");
  });

  it("strips special characters for raw project names", () => {
    // @ and / are stripped — normalizePackageName is for user-typed project names
    expect(normalizePackageName("my app!")).toBe("my-app");
  });

  it("throws on names that produce an empty result", () => {
    expect(() => normalizePackageName("@@@")).toThrow();
  });
});

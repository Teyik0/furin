import { expect, test } from "bun:test";
import { discoveryModule, discoveryModuleFilter } from "../../src/build/discovery-module.ts";

test("route metadata isolation matches native and import separators on Windows", () => {
  const filter = discoveryModuleFilter([String.raw`D:\app\src\pages`]);
  expect(filter.test(String.raw`D:\app\src\pages\index.tsx`)).toBe(true);
  expect(filter.test("D:/app/src/pages/index.tsx")).toBe(true);
  expect(filter.test("D:/app/src/pages-other/index.tsx")).toBe(false);
  expect(filter.test("D:/app/src/api.ts")).toBe(false);
});

test("route metadata isolation escapes directory regex characters", () => {
  const filter = discoveryModuleFilter(["/app (test)/pages"]);
  expect(filter.test("/app (test)/pages/index.tsx")).toBe(true);
  expect(filter.test("/app test/pages/index.tsx")).toBe(false);
});

test.each(["error", "not-found"])(
  "discovery isolates %s boundary resources with either path separator",
  (boundary) => {
    const source =
      "import { api } from './api'; export default function ErrorPage(){ return api.read(); }";
    const paths = [`D:/app/pages/${boundary}.tsx`, `D:\\app\\pages\\${boundary}.tsx`];
    for (const path of paths) {
      const result = discoveryModule(source, path, "tsx");
      expect(result).not.toContain("./api");
      expect(result).not.toContain("api.read()");
      expect(result).toContain("return null");
    }
  }
);

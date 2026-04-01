import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import rootPackageJson from "../../../package.json";
import docsPackageJson from "../../docs/package.json";
import { getPackageCatalog } from "../src/package-catalog.ts";

const SEMVER_PATTERN = /^\d+\.\d+\.\d+/;

describe("package catalog", () => {
  test("stays aligned with workspace source versions", () => {
    const catalog = getPackageCatalog();

    expect(catalog["@teyik0/furin"]).toMatch(SEMVER_PATTERN);
    expect(catalog.elysia).toBe(rootPackageJson.catalog.elysia);
    expect(catalog.react).toBe(rootPackageJson.catalog.react);
    expect(catalog["react-dom"]).toBe(rootPackageJson.catalog["react-dom"]);
    expect(catalog["@types/react"]).toBe(rootPackageJson.catalog["@types/react"]);
    expect(catalog["@types/react-dom"]).toBe(rootPackageJson.catalog["@types/react-dom"]);
    expect(catalog["@types/bun"]).toBe(rootPackageJson.devDependencies["@types/bun"]);
    expect(catalog.typescript).toBe(rootPackageJson.devDependencies.typescript);
    expect(catalog["bun-plugin-tailwind"]).toBe(
      docsPackageJson.dependencies["bun-plugin-tailwind"]
    );
    expect(catalog.tailwindcss).toBe(docsPackageJson.devDependencies.tailwindcss);
    expect(catalog["class-variance-authority"]).toBe(
      docsPackageJson.dependencies["class-variance-authority"]
    );
    expect(catalog.clsx).toBe(docsPackageJson.dependencies.clsx);
    expect(catalog["tailwind-merge"]).toBe(docsPackageJson.dependencies["tailwind-merge"]);
    expect(catalog["radix-ui"]).toBe(docsPackageJson.dependencies["radix-ui"]);
    expect(catalog["lucide-react"]).toBe(docsPackageJson.dependencies["lucide-react"]);
    expect(catalog["tw-animate-css"]).toBe(docsPackageJson.devDependencies["tw-animate-css"]);
  });
});

describe("template files", () => {
  test("minimal template includes the API and loader demo files", () => {
    const templateRoot = resolve(import.meta.dir, "../templates/minimal");

    expect(existsSync(resolve(templateRoot, "src/api/hello.ts"))).toBe(true);
    expect(existsSync(resolve(templateRoot, "src/pages/index.tsx"))).toBe(true);
    expect(readFileSync(resolve(templateRoot, "src/pages/index.tsx"), "utf8")).toContain(
      'fetch(new URL("/api/hello", request.url))'
    );
  });

  test("shadcn template includes the expected starter files", () => {
    const templateRoot = resolve(import.meta.dir, "../templates/shadcn");

    expect(existsSync(resolve(templateRoot, "components.json"))).toBe(true);
    expect(existsSync(resolve(templateRoot, "src/components/ui/button.tsx"))).toBe(true);
    expect(existsSync(resolve(templateRoot, "src/components/ui/card.tsx"))).toBe(true);
    expect(existsSync(resolve(templateRoot, "src/components/ui/input.tsx"))).toBe(true);
  });
});

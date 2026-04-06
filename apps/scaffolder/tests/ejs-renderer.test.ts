import { describe, expect, it } from "bun:test";
import { resolve } from "node:path";
import { renderEjsFile } from "../src/engine/renderer";
import type { EjsTemplateVars } from "../src/pipeline/context";

const TEMPLATES_DIR = resolve(import.meta.dir, "../templates");

const mockVars: EjsTemplateVars = {
  projectName: "My Test App",
  projectNameKebab: "my-test-app",
  projectNamePascal: "MyTestApp",
  furinVersion: "0.1.0-alpha.4",
  features: ["tailwind"],
  versions: {
    "@teyik0/furin": "0.1.0-alpha.4",
    "bun-plugin-tailwind": "^0.0.16",
    elysia: "^1.4.28",
    evlog: "^2.10.0",
    react: "^19.1.0",
    "react-dom": "^19.1.0",
    "@types/bun": "latest",
    "@types/react": "^19.1.0",
    "@types/react-dom": "^19.1.0",
    tailwindcss: "^4.1.3",
    typescript: "^5.8.3",
  },
};

describe("renderEjsFile — simple template", () => {
  it("renders server.ts.ejs with projectName substituted", async () => {
    const src = resolve(TEMPLATES_DIR, "simple/src/server.ts.ejs");
    const output = await renderEjsFile(src, mockVars);
    expect(output).toContain("My Test App running at");
    expect(output).not.toContain("<%=");
  });

  it("renders package.json.ejs with correct name and deps", async () => {
    const src = resolve(TEMPLATES_DIR, "simple/package.json.ejs");
    const output = await renderEjsFile(src, mockVars);
    const parsed = JSON.parse(output);
    expect(parsed.name).toBe("my-test-app");
    expect(parsed.dependencies["@teyik0/furin"]).toBe("0.1.0-alpha.4");
    expect(parsed.dependencies.elysia).toBe("^1.4.28");
    expect(parsed.devDependencies.typescript).toBe("^5.8.3");
  });

  it("renders furin-env.d.ts.ejs without leftover EJS tags", async () => {
    const src = resolve(TEMPLATES_DIR, "simple/furin-env.d.ts.ejs");
    const output = await renderEjsFile(src, mockVars);
    expect(output).not.toContain("<%");
    expect(output).toContain("RouteManifest");
  });
});

describe("renderEjsFile — full template", () => {
  it("renders server.ts.ejs with projectName substituted", async () => {
    const src = resolve(TEMPLATES_DIR, "full/src/server.ts.ejs");
    const output = await renderEjsFile(src, mockVars);
    expect(output).toContain("My Test App running at");
    expect(output).not.toContain("<%=");
  });

  it("renders package.json.ejs with shadcn deps", async () => {
    const fullVars: EjsTemplateVars = {
      ...mockVars,
      furinVersion: "0.1.0-alpha.4",
      features: ["tailwind", "shadcn"],
      versions: {
        ...mockVars.versions,
        "@radix-ui/react-slot": "^1.2.3",
        "class-variance-authority": "^0.7.1",
        clsx: "^2.1.1",
        "lucide-react": "^0.503.0",
        "tailwind-merge": "^3.3.0",
        "tw-animate-css": "^1.2.5",
      },
    };
    const src = resolve(TEMPLATES_DIR, "full/package.json.ejs");
    const output = await renderEjsFile(src, fullVars);
    const parsed = JSON.parse(output);
    expect(parsed.name).toBe("my-test-app");
    expect(parsed.dependencies["@radix-ui/react-slot"]).toBe("^1.2.3");
    expect(parsed.dependencies["class-variance-authority"]).toBe("^0.7.1");
    expect(parsed.dependencies.clsx).toBe("^2.1.1");
  });
});

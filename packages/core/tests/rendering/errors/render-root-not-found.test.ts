import { test } from "bun:test";
import { join as joinPath } from "node:path";

const script = `
await import("./packages/core/tests/setup/evlog-mock.ts");

const { join } = await import("node:path");
const { renderRootNotFound } = await import("./packages/core/src/server/render/index.ts");
const {
  __resetTemplateState,
  setProductionTemplateContent,
} = await import("./packages/core/src/server/render/template.ts");
const { scanPages } = await import("./packages/core/src/server/router/discovery.ts");
const { __setDevMode } = await import("./packages/core/src/server/runtime-env.ts");

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

__setDevMode(false);
const fixturesDir = join(process.cwd(), "packages/core/tests/fixtures/pages/default");

__resetTemplateState();
setProductionTemplateContent(
  '<!DOCTYPE html><html><body><script type="module" src="/prod-entry.js"></script></body></html>'
);
let result = await scanPages(fixturesDir);
let response = await renderRootNotFound(result.root, undefined);
assert(response.status === 404, "production assets response status");
let body = await response.text();
assert(body.includes('src="/prod-entry.js"'), "production entry asset");

__resetTemplateState();
result = await scanPages(fixturesDir);
response = await renderRootNotFound(result.root, undefined);
assert(response.status === 404, "generated template response status");
body = await response.text();
assert(body.includes("__FURIN_DATA__"), "generated template body");

__resetTemplateState();
result = await scanPages(fixturesDir);
const rootWithBrokenNotFound = {
  ...result.root,
  notFound: () => {
    throw new Error("not-found-boom");
  },
};
response = await renderRootNotFound(rootWithBrokenNotFound, undefined);
assert(response.status === 404, "broken not-found fallback status");
body = await response.text();
assert(body.includes("404"), "broken not-found fallback body");
`;

const trustedOriginScript = `
await import("./packages/core/tests/setup/evlog-mock.ts");

const { join } = await import("node:path");
const { renderRootNotFound } = await import("./packages/core/src/server/render/index.ts");
const { __resetTemplateState } = await import("./packages/core/src/server/render/template.ts");
const { scanPages } = await import("./packages/core/src/server/router/discovery.ts");
const { __setDevMode } = await import("./packages/core/src/server/runtime-env.ts");

__setDevMode(true);
__resetTemplateState();
const fixturesDir = join(process.cwd(), "packages/core/tests/fixtures/pages/default");
const result = await scanPages(fixturesDir);
let fetchedUrl;
globalThis.fetch = async (input) => {
  fetchedUrl = String(input);
  return new Response("<!DOCTYPE html><html><body></body></html>");
};

const request = new Request("http://attacker.example/missing");
const response = await renderRootNotFound(result.root, request, "http://127.0.0.1:4321");
if (response.status !== 404) {
  throw new Error("trusted-origin response status");
}
if (fetchedUrl !== "http://127.0.0.1:4321/_bun_hmr_entry") {
  throw new Error(\`unexpected dev-template URL: \${fetchedUrl}\`);
}
`;

test("renderRootNotFound scenarios", () => {
  const proc = Bun.spawnSync({
    cmd: ["bun", "--preload", "./packages/core/tests/setup/global.ts", "-e", script],
    cwd: joinPath(import.meta.dir, "../../../../.."),
    stderr: "pipe",
    stdout: "pipe",
  });
  if (proc.exitCode !== 0) {
    throw new Error(
      [
        `renderRootNotFound subprocess exited with ${proc.exitCode}`,
        new TextDecoder().decode(proc.stdout),
        new TextDecoder().decode(proc.stderr),
      ].join("\n")
    );
  }
});

test("renderRootNotFound fetches the dev template from the trusted listener origin", () => {
  const proc = Bun.spawnSync({
    cmd: ["bun", "--preload", "./packages/core/tests/setup/global.ts", "-e", trustedOriginScript],
    cwd: joinPath(import.meta.dir, "../../../../.."),
    stderr: "pipe",
    stdout: "pipe",
  });
  if (proc.exitCode !== 0) {
    throw new Error(
      [
        `renderRootNotFound subprocess exited with ${proc.exitCode}`,
        new TextDecoder().decode(proc.stdout),
        new TextDecoder().decode(proc.stderr),
      ].join("\n")
    );
  }
});

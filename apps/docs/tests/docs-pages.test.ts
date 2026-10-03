import { expect, test } from "bun:test";
import { createDocsServer } from "../src/server";

test("the sync documentation renders its server content, highlighted code and internal links", async () => {
  const app = await createDocsServer();
  const response = await app.handle(new Request("http://localhost/docs/sync"));
  const html = await response.text();

  expect(response.status).toBe(200);
  expect(html).toContain("Sync &amp; Invalidations");
  expect(html).toContain("Configure One Runtime");
  expect(html).toContain("th-keyword");
  expect(html).toContain('href="/docs/caching"');
  expect(html).not.toContain("__FURIN_DEV_DIAGNOSTIC__");
});

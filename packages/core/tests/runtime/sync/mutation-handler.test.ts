import { describe, expect, test } from "bun:test";
import { Elysia } from "elysia";
import { installMutationHandlers } from "../../../src/server/sync/mutation-handler.ts";

describe.each([false, true])("Sync mounts (precompiled: %s)", (precompiled) => {
  describe.each(["GET", "POST"])("%s requests", (method) => {
    test.each([
      ["", "/api/auth/get-session", "/api/auth/get-session"],
      ["/api", "/api/auth/get-session", "/auth/get-session"],
      ["/api", "/api", "/"],
    ])("preserves mount %s at %s", async (prefix, path, mountedPath) => {
      const app = new Elysia().mount(prefix, async (request) =>
        Response.json(
          {
            url: request.url,
            method: request.method,
            body: await request.text(),
            cookie: request.headers.get("cookie"),
          },
          { headers: { "set-cookie": "session=updated; HttpOnly" } }
        )
      );
      installMutationHandlers(app);
      if (precompiled) {
        app.compile();
      }
      const response = await app.handle(
        new Request(`http://localhost${path}?redirect=%2Fboard`, {
          method,
          headers: { cookie: "session=original", "content-type": "application/json" },
          body: method === "POST" ? '{"email":"user@example.test"}' : undefined,
        })
      );
      expect(response.status).toBe(200);
      expect(response.headers.getSetCookie()).toEqual(["session=updated; HttpOnly"]);
      expect(await response.json()).toEqual({
        url: `http://localhost${mountedPath}?redirect=%2Fboard`,
        method,
        body: method === "POST" ? '{"email":"user@example.test"}' : "",
        cookie: "session=original",
      });
    });
  });
});

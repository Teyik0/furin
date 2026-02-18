import { resolve } from "node:path";
import { Elysia, t } from "elysia";
import { REFRESH_SETUP_CODE } from "./refresh-setup";
import { getHmrClients, getTransformedModule, setupHmrWatcher } from "./watcher";

export function createHmrPlugin(pagesDir: string) {
  setupHmrWatcher(pagesDir);

  return new Elysia({ name: "elysion-hmr" })
    .ws("/__elysion/hmr", {
      body: t.Any(),
      open(ws) {
        const rawWs = ws.raw as unknown as WebSocket;
        getHmrClients().add(rawWs);
        console.log(`[hmr] Client connected (${getHmrClients().size} total)`);
        ws.send(JSON.stringify({ type: "connected" }));
      },
      close(ws) {
        const rawWs = ws.raw as unknown as WebSocket;
        getHmrClients().delete(rawWs);
        console.log(`[hmr] Client disconnected (${getHmrClients().size} remaining)`);
      },
      message(_ws, message) {
        console.log("[hmr] Client message:", message);
      },
    })
    .get("/__refresh-setup.js", () => {
      return new Response(REFRESH_SETUP_CODE, {
        headers: {
          "Content-Type": "application/javascript",
          "Cache-Control": "no-cache",
        },
      });
    })
    .get("/_modules/pages/*", async (ctx) => {
      const relativePath = ctx.path.replace("/_modules/pages/", "");
      const fullPath = resolve(pagesDir, relativePath);

      try {
        const code = await getTransformedModule(fullPath, pagesDir);
        return new Response(code, {
          headers: {
            "Content-Type": "application/javascript",
            "Cache-Control": "no-cache",
          },
        });
      } catch (error) {
        console.error("[hmr] Module transform error:", error);
        return new Response(`// Error: ${error}`, {
          status: 500,
          headers: { "Content-Type": "application/javascript" },
        });
      }
    });
}

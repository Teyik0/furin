import { furin } from "@teyik0/furin";
import { desktopApp } from "@teyik0/furin-electrobun/server";
import { Elysia } from "elysia";
import { initLogger } from "evlog";
import { api } from "./api";
import { sqlite } from "./db";
import { sync } from "./sync";

initLogger({ env: { service: "relay" } });

// desktopApp() must be the first plugin of the default-exported root.
const app = new Elysia({ name: "relay" })
  .use(
    desktopApp({
      window: {
        title: "Relay",
        frame: { width: 1100, height: 780 },
        titleBarStyle: "hiddenInset",
        renderer: "native",
      },
      restrictWebToLoopback: true,
    })
  )
  .onStop(() => sqlite.close())
  .use(api)
  .use(await furin({ pagesDir: `${import.meta.dir}/pages`, sync }));

if (import.meta.main) {
  app.listen({ hostname: "127.0.0.1", port: Number(process.env.PORT ?? 3004) });
  console.log(`Relay: http://127.0.0.1:${app.server?.port}`);
}

export default app;

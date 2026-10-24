// Runtime module of the Bun adapter: the entry of `.furin/build/bun/server.js`
// and of compiled executables. It owns the listener; the application module
// stays listener-free so the build can evaluate it.
import app, { idleTimeout, onShutdown, port, startServer } from "furin:app";
import { startProductionServer } from "../../server/production-server.ts";

if (typeof startServer === "function") {
  await startServer();
} else if (app && typeof app.listen === "function" && !app.server) {
  const declaredPort = app["~config"]?.serve?.port ?? (typeof port === "number" ? port : 3000);
  const serverPort = Number(process.env.PORT ?? declaredPort);
  const { server } = startProductionServer({ app, idleTimeout, onShutdown, port: serverPort });
  console.log(`[furin] Server running at http://localhost:${server.port}`);
}

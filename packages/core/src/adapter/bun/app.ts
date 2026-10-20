// Runtime module of `furin build --target bun --output app`: the entry of
// `.furin/build/bun/app.js`. It re-exports the listener-free application so a
// host can import it into its own Bun process and own startup and shutdown.
// biome-ignore lint/performance/noBarrelFile: the bundle entry of app.js, not a barrel
export { default, idleTimeout, onShutdown, onStartup, port, startServer } from "furin:app";

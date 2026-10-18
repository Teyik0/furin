import type { AnyElysia, Elysia } from "elysia";
import type { RootLayout } from "./router/types.ts";
import type { FurinSyncOption } from "./sync/config.ts";

/** What a development or production runtime contributes to its Elysia app. */
export interface ModeRuntime {
  nativeRoutes: AnyElysia;
  notFound: Elysia;
  /**
   * Registers lifecycle hooks, framework endpoints and assets on the runtime's
   * app before its page routes, so local hooks also cover those routes.
   */
  plugins: (app: AnyElysia) => AnyElysia;
}

export interface ModeOptions {
  clientLogging: boolean | undefined;
  /** Logging, 404 rendering and response headers for the runtime's routes. */
  requestHooks: (root: () => RootLayout) => (app: AnyElysia) => AnyElysia;
  sync: FurinSyncOption | undefined;
}

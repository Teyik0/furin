import { Elysia } from "elysia";
import { BunAdapter, isHTMLBundle } from "elysia/adapter/bun";
import type { ElysiaConfig, EventScope } from "elysia/types";
import { type DesktopMode, type DesktopState, registerDesktopApp } from "./registry";

const HMR_ENTRY = /(?:^|\/)_bun_hmr_entry(?:\/index\.html)?$/;

/** A normal Elysia root on the web; its first wrapper is activated by the desktop host. */
export function createDesktopApp<
  const Prefix extends string = "",
  const Scope extends EventScope = "local",
>(options?: ElysiaConfig<Prefix, Scope>): Elysia<Prefix, Scope> {
  const validate = (mode: DesktopMode): void => {
    if (options?.adapter !== undefined && options.adapter !== BunAdapter) {
      throw new Error(
        "Desktop requires Elysia's default Bun adapter; custom adapters cannot guarantee session dispatch."
      );
    }
    if (options?.serve?.routes !== undefined) {
      throw new Error(
        "Desktop serve.routes bypasses session dispatch; declare routes on the Elysia app instead."
      );
    }
    for (const route of app.routes) {
      if (
        isHTMLBundle(route.handler) &&
        (mode === "build" || route.method !== "GET" || !HMR_ENTRY.test(route.path))
      ) {
        throw new Error(
          `Native HTMLBundle route "${route.path}" bypasses desktop session dispatch. Only GET Furin _bun_hmr_entry assets are permitted in dev, never in build.`
        );
      }
    }
  };
  const state: DesktopState = {
    async validate(mode) {
      await app.modules;
      validate(mode);
      return () => validate(mode);
    },
  };
  // Public configuration disables native promoted Responses. Bun HTML/HMR
  // bypasses dispatch independently and is checked through public route metadata.
  const app = new Elysia<Prefix, Scope>({ ...options, nativeStaticResponse: false }).wrap(
    (next) =>
      (request, ...rest: unknown[]) =>
        state.guard?.(request) ?? next(request, ...rest)
  );
  registerDesktopApp(app, state);
  return app;
}

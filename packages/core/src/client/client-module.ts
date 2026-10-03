import { preloadModule } from "react-dom";

/** A browser-only module whose chunks can be preloaded during SSR. */
export interface ClientModule<T> {
  /** Chunk URLs of the module and its static imports. Empty in dev mode. */
  readonly hrefs: readonly string[];
  /** Imports the module. Only call it in the browser (e.g. in an effect). */
  load: () => Promise<T>;
}

let resolveModuleHrefs: (key: string) => readonly string[] = () => [];
let resolveNonce: () => string | undefined = () => undefined;

/** @internal Reads the nonce from the active server render, without bundling server state. */
export function setClientModuleNonceResolver(resolver: () => string | undefined): void {
  resolveNonce = resolver;
}

/** @internal The server resolves build keys against the client preload manifest. */
export function setClientModuleHrefResolver(resolver: (key: string) => readonly string[]): void {
  resolveModuleHrefs = resolver;
}

/**
 * Declares a module that only runs in the browser, e.g. a WebGL scene.
 *
 * Pass an inline `() => import("./module")`. Furin's build keeps the import in
 * the client bundle, strips it from the server bundle, and records the chunk
 * URLs so `preloadClientModule()` can emit `<link rel="modulepreload">` tags.
 *
 * @param build Injected by Furin's build — never pass it yourself.
 */
export function clientModule<T>(
  load: () => Promise<T>,
  build?: string | readonly string[]
): ClientModule<T> {
  return {
    get hrefs() {
      if (build === undefined) {
        return [];
      }
      return typeof build === "string" ? resolveModuleHrefs(build) : build;
    },
    load,
  };
}

/**
 * Preloads a client module's chunks. Call it while rendering: during SSR React
 * hoists one `<link rel="modulepreload">` per chunk into `<head>`.
 */
export function preloadClientModule<T>(mod: ClientModule<T>): void {
  const nonce = resolveNonce();
  for (const href of mod.hrefs) {
    preloadModule(href, { as: "script", nonce });
  }
}

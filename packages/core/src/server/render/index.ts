// biome-ignore-all lint/performance/noBarrelFile: intentional barrel for public API

export { type LoaderContext, streamToString } from "./assemble.ts";
export { buildElement, buildErrorElement } from "./element.tsx";
export { handleISR } from "./isr.ts";
export {
  hasRequestLoader,
  type LoaderResult,
  runLoaders,
  serializeDeferredRejection,
} from "./loaders.ts";
export { renderRootNotFound } from "./not-found.ts";

export { prerenderSSG, warmSSGCache } from "./ssg.ts";
export {
  assertDeferredModeAllowed,
  type PreparedRender,
  prepareRender,
  type RenderResult,
  renderForPath,
  renderSSR,
  renderToHTML,
  serializeLoaderDataNdjson,
  withSSRRouterContext,
} from "./ssr.ts";

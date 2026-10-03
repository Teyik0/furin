import { AsyncLocalStorage } from "node:async_hooks";
import { renderToReadableStream as renderReactStream } from "react-dom/server";
import { setClientModuleNonceResolver } from "../../client/client-module.ts";

const renderNonces = new AsyncLocalStorage<string | undefined>();
setClientModuleNonceResolver(() => renderNonces.getStore());

/** Keep module preloads in the same nonce scope as React's streamed scripts. */
export function renderToReadableStream(
  element: Parameters<typeof renderReactStream>[0],
  options: Parameters<typeof renderReactStream>[1]
): ReturnType<typeof renderReactStream> {
  const nonce = options?.nonce;
  return renderNonces.run(typeof nonce === "string" ? nonce : nonce?.script, () =>
    renderReactStream(element, options)
  );
}

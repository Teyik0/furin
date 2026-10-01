import { createElement, type ReactNode } from "react";
import {
  type DocumentAssets,
  DocumentProvider,
  type DocumentState,
} from "../../client/document.tsx";
import { QueryStoreContext } from "../../client/query.tsx";
import { QueryStore } from "../../client/query-store.ts";
import type { HeadOptions } from "../../client.ts";
import { containsRscSource, serializeRouteFrames } from "../../shared/route-frame.ts";
import type { QuerySeed } from "../../shared/sync-query.ts";
import { currentInstance } from "../instance.ts";
import { getSyncPath } from "../sync/config.ts";
import { safeJson } from "./shell.ts";

export function withDocumentState(
  element: ReactNode,
  assets: DocumentAssets,
  head: HeadOptions | undefined,
  data: object | undefined,
  nonce?: string
): ReactNode {
  const syncPath = getSyncPath();
  const browserEventsClientPath = `${currentInstance().prefix}/_furin/events/client.js`;
  const resolvedAssets =
    syncPath === undefined || assets.frameworkModules.includes(browserEventsClientPath)
      ? assets
      : {
          ...assets,
          frameworkModules: [browserEventsClientPath, ...assets.frameworkModules],
        };
  const routeFrames =
    data !== undefined && containsRscSource(data)
      ? serializeRouteFrames(data, undefined)
      : undefined;
  const state: DocumentState = {
    assets: resolvedAssets,
    dataJson: data === undefined || routeFrames !== undefined ? undefined : safeJson(data),
    head,
    nonce,
    routeFrames,
    syncJson: syncPath === undefined ? undefined : safeJson({ path: syncPath }),
  };
  const queries = new QueryStore(undefined);
  queries.hydrate((data as { __furinQueries?: QuerySeed[] } | undefined)?.__furinQueries ?? []);
  return createElement(
    DocumentProvider,
    { value: state },
    createElement(QueryStoreContext.Provider, { value: queries }, element)
  );
}

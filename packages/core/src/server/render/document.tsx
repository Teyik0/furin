import { createElement, type ReactNode } from "react";
import {
  type DocumentAssets,
  DocumentProvider,
  type DocumentState,
} from "../../client/document.tsx";
import { QueryStoreContext } from "../../client/query.tsx";
import { QueryStore } from "../../client/query-store.ts";
import type { HeadOptions } from "../../client.ts";
import { isJsonObject } from "../../shared/compact-json.ts";
import { serializeRouteFrames } from "../../shared/route-frame.ts";
import type { QuerySeed } from "../../shared/sync-query.ts";
import { currentInstance } from "../instance.ts";
import { getSyncPath } from "../sync/config.ts";
import { rebaseAssetHref } from "./asset-path.ts";
import { safeJson } from "./shell.ts";

export function withDocumentState(
  element: ReactNode,
  assets: DocumentAssets,
  head: HeadOptions | undefined,
  data: object | undefined,
  nonce?: string
): ReactNode {
  const instance = currentInstance();
  const rebase = (href: string): string => rebaseAssetHref(href, instance);
  const rebasedAssets =
    instance.prefix === instance.declaredPrefix
      ? assets
      : {
          ...assets,
          entryModule: assets.entryModule === undefined ? undefined : rebase(assets.entryModule),
          faviconHref: assets.faviconHref === undefined ? undefined : rebase(assets.faviconHref),
          frameworkModules: assets.frameworkModules.map(rebase),
          modulePreloads: assets.modulePreloads?.map(rebase),
          stylesheets: assets.stylesheets.map(rebase),
        };
  const syncPath = getSyncPath();
  const browserEventsClientPath = `${currentInstance().prefix}/_furin/events/client.js`;
  const resolvedAssets =
    syncPath === undefined || rebasedAssets.frameworkModules.includes(browserEventsClientPath)
      ? rebasedAssets
      : {
          ...rebasedAssets,
          frameworkModules: [browserEventsClientPath, ...rebasedAssets.frameworkModules],
        };
  const routeFrames =
    data !== undefined && !isJsonObject(data) ? serializeRouteFrames(data, undefined) : undefined;
  const state: DocumentState = {
    assets: resolvedAssets,
    dataJson: data === undefined || routeFrames !== undefined ? undefined : safeJson(data),
    head: {
      ...head,
      meta: [
        ...(head?.meta ?? []).filter(
          (meta) => !("name" in meta && meta.name === "furin-base-path")
        ),
        { name: "furin-base-path", content: instance.prefix },
      ],
    },
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

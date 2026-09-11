import { createElement, type ReactNode } from "react";
import {
  type DocumentAssets,
  DocumentProvider,
  type DocumentState,
} from "../../client/document.tsx";
import type { HeadOptions } from "../../client.ts";
import { currentInstance } from "../instance.ts";
import { getSyncPath } from "../sync/config.ts";
import { safeJson } from "./shell.ts";

export function withDocumentState(
  element: ReactNode,
  assets: DocumentAssets,
  head: HeadOptions | undefined,
  data: object | undefined
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
  const state: DocumentState = {
    assets: resolvedAssets,
    dataJson: data === undefined ? undefined : safeJson(data),
    head,
    syncJson: syncPath === undefined ? undefined : safeJson({ path: syncPath }),
  };
  return createElement(DocumentProvider, { value: state }, element);
}

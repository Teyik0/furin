import { createElement, type ReactNode } from "react";
import {
  type DocumentAssets,
  DocumentProvider,
  type DocumentState,
} from "../../client/document.tsx";
import type { HeadOptions } from "../../client.ts";
import { getSyncStreamPath } from "../sync/config.ts";
import { safeJson } from "./shell.ts";

export function withDocumentState(
  element: ReactNode,
  assets: DocumentAssets,
  head: HeadOptions | undefined,
  data: object | undefined
): ReactNode {
  const syncStreamPath = getSyncStreamPath();
  const state: DocumentState = {
    assets,
    dataJson: data === undefined ? undefined : safeJson(data),
    head,
    syncJson: syncStreamPath === undefined ? undefined : safeJson({ stream: syncStreamPath }),
  };
  return createElement(DocumentProvider, { value: state }, element);
}

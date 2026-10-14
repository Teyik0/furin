import { createElement, type ElementType, type ReactNode } from "react";
import { FurinDocumentFallback } from "./document.tsx";
import type { RuntimeData, RuntimeRoute } from "./internal/runtime-types.ts";

/** Wrap loader fallbacks only in layouts whose complete ancestry succeeded. */
export function wrapLoaderLayouts(
  element: ReactNode,
  chain: readonly RuntimeRoute[],
  data: RuntimeData
): ReactNode {
  let wrapped = element;
  const results = data.__furinLayouts as RuntimeData[];
  const deferred = data.__furinLayoutDeferred as { [key: string]: string }[] | undefined;
  const context = { params: data.params, path: data.path, query: data.query };
  let inherited: RuntimeData = context;
  const props = results.map((own, index) => {
    const promises = Object.fromEntries(
      Object.entries(deferred?.[index] ?? {}).map(([key, slot]) => [key, data[slot]])
    );
    inherited = { ...inherited, ...own, ...promises, ...context };
    return inherited;
  });
  for (let index = props.length - 1; index >= 0; index -= 1) {
    const layout = chain[index]?.layout;
    if (layout) {
      wrapped = createElement(layout as ElementType, props[index], wrapped);
    }
  }
  return results.length === 0 ? createElement(FurinDocumentFallback, null, wrapped) : wrapped;
}

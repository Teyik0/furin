// biome-ignore-all lint/performance/noBarrelFile: furin/rsc is the public RSC entrypoint

import { createElement, type ReactNode } from "react";
import { encodeFlight } from "./rsc/codec.ts";
import { installClientCodec } from "./rsc/server-client-codec.ts";
import {
  type CompositeComponentSource,
  createRenderableSource,
  decodeFlightBytes,
  type RenderableServerComponent,
} from "./rsc/shared.tsx";
import { RSC_SOURCE, SLOT_MARKER } from "./rsc/symbols.ts";

installClientCodec();

export { FurinRscRenderError, isFurinRscRenderError } from "./rsc/render-error.ts";
// react-doctor-disable-next-line react-doctor/only-export-components
export * from "./rsc/shared.tsx";

type CompositePropsWithSupportedChildren<TProps extends object> = TProps extends {
  children?: infer TChildren;
}
  ? [TChildren] extends [ReactNode | undefined]
    ? Omit<TProps, "children"> & { children?: ReactNode }
    : never
  : TProps;

export async function renderServerComponent<TNode extends ReactNode>(
  node: TNode
): Promise<RenderableServerComponent<TNode>> {
  const bytes = await encodeFlight(node, undefined, "renderServerComponent");
  return createRenderableSource<TNode>({
    bytes,
    kind: "renderable",
    tree: decodeFlightBytes(bytes),
  });
}

function createSlotProxy<TProps extends object>(): TProps {
  const cache = new Map<string, (...args: unknown[]) => ReactNode>();
  return new Proxy({} as TProps, {
    get(_target, property) {
      if (property === "then" || typeof property !== "string") {
        return;
      }
      if (property === "children") {
        return createElement(SLOT_MARKER, { args: [], name: property });
      }
      let slot = cache.get(property);
      if (slot === undefined) {
        slot = (...args: unknown[]) => createElement(SLOT_MARKER, { args, name: property });
        cache.set(property, slot);
      }
      return slot;
    },
  });
}

export async function createCompositeComponent<TProps extends object>(
  component: (props: CompositePropsWithSupportedChildren<TProps>) => ReactNode | Promise<ReactNode>
): Promise<CompositeComponentSource<TProps>> {
  const proxy = createSlotProxy<CompositePropsWithSupportedChildren<TProps>>();
  function CompositeServerTree(): ReactNode | Promise<ReactNode> {
    return component(proxy);
  }
  const bytes = await encodeFlight(
    createElement(CompositeServerTree),
    undefined,
    "createCompositeComponent"
  );
  return {
    [RSC_SOURCE]: {
      bytes,
      kind: "composite",
      tree: decodeFlightBytes(bytes),
    },
  };
}

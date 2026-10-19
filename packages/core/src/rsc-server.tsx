import { createElement, type ReactNode } from "react";
import { drainFlight } from "./rsc/flight-drain.ts";
import type { RscRenderOperation } from "./rsc/render-error.ts";
import { installClientCodec } from "./rsc/server-client-codec.ts";
import { renderFlight } from "./rsc/server-codec.ts";
import type {
  CompositeComponentSource,
  RenderableServerComponent,
  RscSourceState,
} from "./rsc/shared.tsx";
import { decodeFlightBytes } from "./rsc/shared.tsx";
import { type CompositePropsWithSupportedChildren, createSlotProxy } from "./rsc/slot-proxy.ts";
import { RSC_SOURCE } from "./rsc/symbols.ts";

installClientCodec();

// biome-ignore lint/performance/noBarrelFile: react-server condition for the public furin/rsc entrypoint
export { FurinRscRenderError, isFurinRscRenderError } from "./rsc/render-error.ts";

function renderBytes(node: ReactNode, operation: RscRenderOperation): Promise<Uint8Array> {
  return drainFlight(renderFlight(node, undefined), operation);
}

async function RscNode({ state }: { state: RscSourceState }): Promise<ReactNode> {
  return (await state.tree) as ReactNode;
}

function createServerRenderableSource<TNode extends ReactNode>(
  state: RscSourceState
): RenderableServerComponent<TNode> {
  const element = createElement(RscNode, { state });
  return new Proxy(element, {
    get(target, property, receiver) {
      if (property === RSC_SOURCE) {
        return state;
      }
      return Reflect.get(target, property, receiver);
    },
    has(target, property) {
      return property === RSC_SOURCE || Reflect.has(target, property);
    },
  }) as RenderableServerComponent<TNode>;
}

// react-doctor-disable-next-line react-doctor/only-export-components
export async function renderServerComponent<TNode extends ReactNode>(
  node: TNode
): Promise<RenderableServerComponent<TNode>> {
  const bytes = await renderBytes(node, "renderServerComponent");
  return createServerRenderableSource<TNode>({
    bytes,
    kind: "renderable",
    tree: decodeFlightBytes(bytes),
  });
}

// react-doctor-disable-next-line react-doctor/only-export-components
export async function createCompositeComponent<TProps extends object>(
  component: (props: CompositePropsWithSupportedChildren<TProps>) => ReactNode | Promise<ReactNode>
): Promise<CompositeComponentSource<TProps>> {
  const proxy = createSlotProxy<CompositePropsWithSupportedChildren<TProps>>();
  function Tree(): ReactNode | Promise<ReactNode> {
    return component(proxy);
  }
  const bytes = await renderBytes(createElement(Tree), "createCompositeComponent");
  return {
    [RSC_SOURCE]: { bytes, kind: "composite", tree: Promise.resolve(null) },
  };
}

export function CompositeComponent(): never {
  throw new Error("[furin/rsc] CompositeComponent cannot render inside the RSC graph");
}

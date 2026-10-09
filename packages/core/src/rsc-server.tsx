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
import { RSC_SOURCE, SLOT_MARKER } from "./rsc/symbols.ts";

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

function createSlotProxy<TProps extends object>(): TProps {
  return new Proxy({} as TProps, {
    get(_target, property) {
      if (property === "then" || typeof property !== "string") {
        return;
      }
      if (property === "children") {
        return createElement(SLOT_MARKER, { args: [], name: property });
      }
      return (...args: unknown[]) => createElement(SLOT_MARKER, { args, name: property });
    },
  });
}

type CompositePropsWithSupportedChildren<TProps extends object> = TProps extends {
  children?: infer TChildren;
}
  ? [TChildren] extends [ReactNode | undefined]
    ? Omit<TProps, "children"> & { children?: ReactNode }
    : never
  : TProps;

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

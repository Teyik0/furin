import {
  Children,
  cloneElement,
  createElement,
  isValidElement,
  type ReactElement,
  type ReactNode,
  use,
} from "react";
import { decodeFlight } from "./client-codec.ts";
import { RSC_SOURCE, SLOT_MARKER } from "./symbols.ts";

export type RscSourceKind = "composite" | "renderable";

export interface RscSourceState {
  bytes: Uint8Array;
  kind: RscSourceKind;
  tree: Promise<unknown>;
}

declare const renderableServerComponent: unique symbol;

export type RenderableServerComponent<TNode extends ReactNode = ReactNode> = ReactElement & {
  readonly [renderableServerComponent]: TNode;
};

export interface CompositeComponentSource<TProps extends object> {
  readonly "~types"?: { props: TProps };
  readonly [RSC_SOURCE]: RscSourceState;
}

export type CompositeComponentProps<TProps extends object> = Omit<TProps, "src"> & {
  src: CompositeComponentSource<TProps>;
};

function RscNode({ state }: { state: RscSourceState }): ReactNode {
  return use(state.tree) as ReactNode;
}

export function decodeFlightBytes(bytes: Uint8Array): Promise<unknown> {
  return decodeFlight(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    })
  );
}

export function createRenderableSource<TNode extends ReactNode>(
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

export function isRscSource(value: unknown): value is { readonly [RSC_SOURCE]: RscSourceState } {
  return (
    (typeof value === "object" || typeof value === "function") &&
    value !== null &&
    RSC_SOURCE in value
  );
}

export function getRscSourceState(value: unknown): RscSourceState | undefined {
  return isRscSource(value) ? value[RSC_SOURCE] : undefined;
}

export function restoreRscSource(kind: RscSourceKind, bytes: Uint8Array): unknown {
  const state: RscSourceState = { bytes, kind, tree: decodeFlightBytes(bytes) };
  return kind === "renderable" ? createRenderableSource(state) : { [RSC_SOURCE]: state };
}

function containsSlot(value: unknown, visited: WeakSet<object>): value is object {
  if (value === null || typeof value !== "object" || visited.has(value)) {
    return false;
  }
  visited.add(value);
  if (isValidElement(value)) {
    return value.type === SLOT_MARKER || containsSlot(value.props, visited);
  }
  if (Array.isArray(value)) {
    return value.some((item) => containsSlot(item, visited));
  }
  return (
    Object.getPrototypeOf(value) === Object.prototype &&
    Object.values(value).some((item) => containsSlot(item, visited))
  );
}

function resolveSlotArgument(
  value: unknown,
  slots: object,
  visited: WeakMap<object, unknown>
): unknown {
  if (!containsSlot(value, new WeakSet())) {
    return value;
  }
  const cached = visited.get(value);
  if (cached !== undefined) {
    return cached;
  }
  if (isValidElement(value)) {
    const resolved = resolveSlotElement(value, slots);
    return isValidElement(resolved) ? Children.map(value, () => resolved)?.[0] : resolved;
  }
  if (Array.isArray(value)) {
    const result: unknown[] = [];
    visited.set(value, result);
    for (const item of value) {
      result.push(resolveSlotArgument(item, slots, visited));
    }
    const keys = new Set(result.filter(isValidElement).map((element) => element.key));
    for (const [index, resolved] of result.entries()) {
      if (isValidElement(resolved) && resolved.key === null) {
        let key = String(index);
        while (keys.has(key)) {
          key = `.${key}`;
        }
        keys.add(key);
        result[index] = cloneElement(resolved, { key });
      }
    }
    return result;
  }
  const result = {};
  visited.set(value, result);
  for (const [key, item] of Object.entries(value)) {
    Object.defineProperty(result, key, {
      configurable: true,
      enumerable: true,
      value: resolveSlotArgument(item, slots, visited),
      writable: true,
    });
  }
  return result;
}

function resolveSlotElement(child: ReactElement, slots: object): ReactNode {
  if (child.type === SLOT_MARKER) {
    const marker = child.props as { args?: unknown[]; name?: string };
    if (typeof marker.name !== "string") {
      return null;
    }
    const implementation = Reflect.get(slots, marker.name) as unknown;
    if (typeof implementation === "function") {
      const visited = new WeakMap<object, unknown>();
      const args = (marker.args ?? []).map((argument) =>
        resolveSlotArgument(argument, slots, visited)
      );
      return (implementation as (...args: unknown[]) => ReactNode)(...args);
    }
    return implementation as ReactNode;
  }
  const props = resolveSlotArgument(child.props, slots, new WeakMap());
  return props === child.props ? child : cloneElement(child, props as object);
}

function resolveSlots(node: ReactNode, slots: object): ReactNode {
  return Children.map(node, (child) =>
    isValidElement(child) ? resolveSlotElement(child, slots) : child
  );
}

export function CompositeComponent<TProps extends object>(
  props: CompositeComponentProps<TProps>
): ReactNode {
  const { src, ...slots } = props;
  return resolveSlots(use(src[RSC_SOURCE].tree) as ReactNode, slots);
}

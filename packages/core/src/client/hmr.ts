import { createElement, type ReactNode } from "react";

type ClientComponent<Props> = (props: Props) => ReactNode;
const HOT_COMPONENT_SIGNATURE = Symbol.for("furin.hmr.hook-signature");

export interface HotComponentSlot {
  boundary: ClientComponent<never>;
  current: ClientComponent<never>;
  signature: string | undefined;
  stable: ClientComponent<never>;
}

export type HotComponentRegistry = Map<string, HotComponentSlot>;

function readHookSignature<Props>(component: ClientComponent<Props>): string | undefined {
  const signed = component as ClientComponent<Props> & { [key: symbol]: unknown };
  const value = signed[HOT_COMPONENT_SIGNATURE];
  if (!(Array.isArray(value) && value.every((name) => typeof name === "string"))) {
    return;
  }
  return value.join("\0");
}

function createHotBoundary(slot: HotComponentSlot): ClientComponent<never> {
  return (props) => slot.current(props);
}

export function reconcileHotComponentRegistry(
  registry: HotComponentRegistry,
  activeKeys: ReadonlySet<string>
): void {
  for (const key of registry.keys()) {
    if (!activeKeys.has(key)) {
      registry.delete(key);
    }
  }
}

export function updateHotComponent<Props>(
  registry: HotComponentRegistry,
  key: string,
  component: ClientComponent<Props>
): ClientComponent<Props> {
  const existing = registry.get(key);
  if (existing) {
    existing.current = component as ClientComponent<never>;
    const signature = readHookSignature(component);
    if (signature !== existing.signature) {
      existing.signature = signature;
      existing.boundary = createHotBoundary(existing);
    }
    return existing.stable as ClientComponent<Props>;
  }

  const slot: HotComponentSlot = {
    boundary: (props) => slot.current(props),
    current: component as ClientComponent<never>,
    signature: readHookSignature(component),
    stable: (props) => createElement(slot.boundary, props) as unknown as ReactNode,
  };
  registry.set(key, slot);
  return slot.stable as ClientComponent<Props>;
}

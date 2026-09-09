import type React from "react";

type ClientComponent<Props> = (props: Props) => React.ReactNode;

export interface HotComponentSlot {
  current: ClientComponent<never>;
  stable: ClientComponent<never>;
}

export type HotComponentRegistry = Map<string, HotComponentSlot>;

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
    return existing.stable as ClientComponent<Props>;
  }

  const slot: HotComponentSlot = {
    current: component as ClientComponent<never>,
    stable: (props) => slot.current(props),
  };
  registry.set(key, slot);
  return slot.stable as ClientComponent<Props>;
}

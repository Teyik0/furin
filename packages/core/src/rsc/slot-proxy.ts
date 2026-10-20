import { createElement, type ReactNode } from "react";
import { SLOT_MARKER } from "./symbols.ts";

export type CompositePropsWithSupportedChildren<TProps extends object> = TProps extends {
  children?: infer TChildren;
}
  ? [TChildren] extends [ReactNode | undefined]
    ? Omit<TProps, "children"> & { children?: ReactNode }
    : never
  : TProps;

/**
 * Props handed to a composite component on the server: `children` and every
 * render prop become slot markers that the client fills in after decoding.
 */
export function createSlotProxy<TProps extends object>(): TProps {
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

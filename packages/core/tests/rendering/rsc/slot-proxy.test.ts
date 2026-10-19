import { describe, expect, test } from "bun:test";
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { createSlotProxy } from "../../../src/rsc/slot-proxy.ts";
import { SLOT_MARKER } from "../../../src/rsc/symbols.ts";

interface SlotProps {
  children?: ReactNode;
  renderItem: (id: string, index: number) => ReactNode;
}

function slotElement(node: ReactNode): ReactElement<{ args: unknown[]; name: string }> {
  if (!isValidElement<{ args: unknown[]; name: string }>(node)) {
    throw new Error("expected a slot element");
  }
  return node;
}

describe("createSlotProxy", () => {
  test("children reads as a slot marker without arguments", () => {
    const slot = slotElement(createSlotProxy<SlotProps>().children);

    expect(slot.type).toBe(SLOT_MARKER);
    expect(slot.props).toEqual({ args: [], name: "children" });
  });

  test("a render prop returns a slot marker carrying its call arguments", () => {
    const slot = slotElement(createSlotProxy<SlotProps>().renderItem("card-1", 2));

    expect(slot.type).toBe(SLOT_MARKER);
    expect(slot.props).toEqual({ args: ["card-1", 2], name: "renderItem" });
  });

  test("a render prop keeps the same identity across reads", () => {
    const props = createSlotProxy<SlotProps>();

    expect(props.renderItem).toBe(props.renderItem);
  });

  test("is not thenable, so awaiting the props does not hang", async () => {
    const props = createSlotProxy<SlotProps>();

    expect((props as SlotProps & { then?: unknown }).then).toBeUndefined();
    expect(await Promise.resolve(props)).toBe(props);
  });
});

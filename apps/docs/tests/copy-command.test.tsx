import { afterEach, beforeEach, expect, test } from "bun:test";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import {
  installDom,
  resetDomState,
  uninstallDom,
} from "../../../packages/core/tests/support/dom.ts";
import { CopyCommand } from "../src/components/landing/copy-command";

beforeEach(() => {
  installDom();
  resetDomState();
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: () => Promise.resolve() },
  });
});

afterEach(async () => {
  await uninstallDom();
});

test("copy confirmation stays visible for 1600 ms after the latest successful copy", async () => {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    await act(() => root.render(createElement(CopyCommand)));
    const button = container.querySelector("button") as HTMLButtonElement;
    await act(async () => {
      button.click();
      await Promise.resolve();
    });
    await act(() => Bun.sleep(1000));
    await act(async () => {
      button.click();
      await Promise.resolve();
    });
    await act(() => Bun.sleep(1000));
    expect(button.getAttribute("aria-label")).toBe("Copied to clipboard");
    await act(() => Bun.sleep(700));
    expect(button.getAttribute("aria-label")).toBe("Copy command: bun create furin@latest");
  } finally {
    act(() => root.unmount());
    container.remove();
  }
});

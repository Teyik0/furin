import { afterEach, beforeEach, expect, test } from "bun:test";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { installDom, resetDomState, uninstallDom } from "../../../packages/core/tests/support/dom";
import { CodeCopyBridge } from "../src/components/code-copy-bridge";

let copies: string[];
beforeEach(() => {
  installDom();
  resetDomState();
  copies = [];
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: {
      writeText: (text: string) => {
        copies.push(text);
        return Promise.resolve();
      },
    },
  });
});
afterEach(async () => {
  await uninstallDom();
});

async function renderBridge() {
  const container = document.createElement("div");
  container.innerHTML =
    '<div class="not-prose"><pre>first</pre><button data-code-copy><svg><path /></svg></button></div><div class="not-prose"><pre>second</pre><button data-code-copy></button></div>';
  document.body.appendChild(container);
  const root = createRoot(container.appendChild(document.createElement("div")));
  await act(() => root.render(createElement(CodeCopyBridge)));
  return {
    container,
    cleanup: () => {
      act(() => root.unmount());
      container.remove();
    },
  };
}

test("clicking the copy icon copies its code", async () => {
  const { container, cleanup } = await renderBridge();
  try {
    await act(async () => {
      container.querySelector("path")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
    });
    expect(copies).toEqual(["first"]);
  } finally {
    cleanup();
  }
});

test("copy buttons reset independently and remain usable after consecutive copies", async () => {
  const { container, cleanup } = await renderBridge();
  try {
    const buttons = container.querySelectorAll("button");
    await act(async () => {
      buttons[0]?.click();
      await Promise.resolve();
      buttons[1]?.click();
      await Promise.resolve();
    });
    expect(copies).toEqual(["first", "second"]);
    await act(() => Bun.sleep(1600));
    expect([...buttons].every((button) => button.dataset.copied === undefined)).toBe(true);
    await act(async () => {
      buttons[0]?.click();
      await Promise.resolve();
    });
    expect(copies).toEqual(["first", "second", "first"]);
  } finally {
    cleanup();
  }
});

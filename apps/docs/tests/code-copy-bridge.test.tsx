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

test("each copy button resets on its own timer and stays usable", async () => {
  const { container, cleanup } = await renderBridge();
  try {
    const [first, second] = container.querySelectorAll("button");
    await act(async () => {
      first?.click();
      await Promise.resolve();
    });
    await act(() => Bun.sleep(800));
    await act(async () => {
      second?.click();
      await Promise.resolve();
    });
    expect(copies).toEqual(["first", "second"]);
    await act(() => Bun.sleep(900));
    expect(first?.dataset.copied).toBeUndefined();
    expect(second?.dataset.copied).toBe("");
    await act(async () => {
      first?.click();
      await Promise.resolve();
    });
    expect(copies).toEqual(["first", "second", "first"]);
  } finally {
    cleanup();
  }
});

test("a copy announces itself to assistive technology, then restores the label", async () => {
  const { container, cleanup } = await renderBridge();
  try {
    const button = container.querySelector("button");
    button?.setAttribute("aria-label", "Copy code");
    await act(async () => {
      button?.click();
      await Promise.resolve();
    });
    expect(button?.getAttribute("aria-label")).toBe("Copied");
    await act(() => Bun.sleep(1600));
    expect(button?.getAttribute("aria-label")).toBe("Copy code");
  } finally {
    cleanup();
  }
});

test("a click without the Clipboard API copies nothing and does not throw", async () => {
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: undefined });
  const { container, cleanup } = await renderBridge();
  const errors: unknown[] = [];
  const onError = (event: ErrorEvent) => errors.push(event.error);
  window.addEventListener("error", onError);
  try {
    const button = container.querySelector("button");
    await act(async () => {
      button?.click();
      await Promise.resolve();
    });
    expect(errors).toEqual([]);
    expect(button?.dataset.copied).toBeUndefined();
  } finally {
    window.removeEventListener("error", onError);
    cleanup();
  }
});

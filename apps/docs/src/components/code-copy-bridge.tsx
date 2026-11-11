import { useEffect } from "react";

/**
 * One delegated document listener for all `button[data-code-copy]` buttons:
 * rendered by the rehype pipeline (standalone code windows) and CodeTabs.
 * Clicks copy the enclosing window's code text; static markup stays inert.
 */
const COPY_LABEL = "Copy code";
const COPIED_LABEL = "Copied";

function resetButton(button: HTMLElement): void {
  delete button.dataset.copied;
  button.setAttribute("aria-label", COPY_LABEL);
}

export function CodeCopyBridge() {
  useEffect(() => {
    const timers = new Map<HTMLElement, number>();

    function findCodeText(button: HTMLElement): string | null {
      const container = button.closest(".not-prose");
      if (container === null) {
        return null;
      }
      const pre = container.querySelector("pre");
      return pre?.textContent ?? null;
    }

    function onClick(event: MouseEvent): void {
      const button =
        event.target instanceof Element
          ? event.target.closest<HTMLElement>("button[data-code-copy]")
          : null;
      if (button === null || button.dataset.copied !== undefined) {
        return;
      }
      const text = findCodeText(button);
      // The Clipboard API is missing outside secure contexts.
      if (text === null || navigator.clipboard === undefined) {
        return;
      }
      event.preventDefault();
      navigator.clipboard
        .writeText(text)
        .then(() => {
          button.dataset.copied = "";
          button.setAttribute("aria-label", COPIED_LABEL);
          window.clearTimeout(timers.get(button));
          timers.set(
            button,
            window.setTimeout(() => {
              resetButton(button);
              timers.delete(button);
            }, 1500)
          );
        })
        .catch(() => undefined);
    }

    document.addEventListener("click", onClick);
    return () => {
      document.removeEventListener("click", onClick);
      for (const [button, timer] of timers) {
        window.clearTimeout(timer);
        resetButton(button);
      }
    };
  }, []);

  return null;
}

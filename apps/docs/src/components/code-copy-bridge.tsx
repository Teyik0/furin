import { useEffect } from "react";

/**
 * One delegated document listener for all `button[data-code-copy]` buttons:
 * rendered by the rehype pipeline (standalone code windows) and CodeTabs.
 * Clicks copy the enclosing window's code text; static markup stays inert.
 */
export function CodeCopyBridge() {
  useEffect(() => {
    let timer: number | undefined;

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
        event.target instanceof HTMLElement
          ? event.target.closest<HTMLElement>("button[data-code-copy]")
          : null;
      if (button === null || button.dataset.copied !== undefined) {
        return;
      }
      const text = findCodeText(button);
      if (text === null) {
        return;
      }
      event.preventDefault();
      navigator.clipboard
        .writeText(text)
        .then(() => {
          button.dataset.copied = "";
          window.clearTimeout(timer);
          timer = window.setTimeout(() => delete button.dataset.copied, 1500);
        })
        .catch(() => undefined);
    }

    document.addEventListener("click", onClick);
    return () => {
      document.removeEventListener("click", onClick);
      window.clearTimeout(timer);
    };
  }, []);

  return null;
}

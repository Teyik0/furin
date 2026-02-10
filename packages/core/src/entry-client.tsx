import type { FC } from "react";
import { hydrateRoot } from "react-dom/client";

interface WindowWithData extends Window {
  __ELYSION_PAGE__?: FC<Record<string, unknown>>;
}

declare const window: WindowWithData;

function init() {
  const dataElement = document.getElementById("__ELYSION_DATA__");
  const data = dataElement ? JSON.parse(dataElement.textContent || "{}") : {};

  const PageComponent = window.__ELYSION_PAGE__;
  if (!PageComponent) {
    console.error("[elysion] Page component not found");
    return;
  }

  const rootElement = document.getElementById("root");
  if (!rootElement) {
    console.error("[elysion] Root element not found");
    return;
  }

  hydrateRoot(rootElement, <PageComponent {...data} />);
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}

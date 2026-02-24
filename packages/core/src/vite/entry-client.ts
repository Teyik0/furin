import type { ResolvedRoute, RootLayout } from "../router";

export function generateHydrateEntry(routes: ResolvedRoute[], root: RootLayout | null): string {
  const routeEntries = routes.map((r) => {
    const regexPattern = r.pattern.replace(/:[^/]+/g, "([^/]+)").replace(/\*/g, "(.*)");
    return `{
      pattern: "${r.pattern}",
      regex: new RegExp("^${regexPattern}$"),
      modulePath: "${r.pagePath.replace(/\\/g, "/")}",
      routeChain: ${JSON.stringify(r.routeChain)}
    }`;
  });
  const hasRoot = root !== null;
  return `import { hydrateRoot } from "react-dom/client";
import { createElement } from "react";
// Route definitions
const routes = [
  ${routeEntries.join(",\n")}
];
// Collect layouts from route chain
function collectLayouts(routeChain) {
  return routeChain
    .filter(r => r.layout)
    .map(r => r.layout)
    .reverse();
}
// Inject suppressHydrationWarning for html/head/body
function injectSuppressHydration(element) {
  if (!element || typeof element !== 'object') return element;
  const type = element.type;
  const props = element.props || {};
  if (type === 'html' || type === 'head' || type === 'body') {
    return {
      ...element,
      props: {
        ...props,
        suppressHydrationWarning: true,
        children: props.children
          ? (Array.isArray(props.children)
              ? props.children.map(injectSuppressHydration)
              : injectSuppressHydration(props.children))
          : undefined
      }
    };
  }
  if (props.children) {
    return {
      ...element,
      props: {
        ...props,
        children: Array.isArray(props.children)
          ? props.children.map(injectSuppressHydration)
          : injectSuppressHydration(props.children)
      }
    };
  }
  return element;
}
// Build element with layouts
function buildElement(component, loaderData, routeChain) {
  const layouts = collectLayouts(routeChain);
  let element = createElement(component, loaderData);
  for (const Layout of layouts) {
    element = createElement(Layout, { ...loaderData, children: element });
  }
  return injectSuppressHydration(element);
}
// Get loader data from SSR
function getLoaderData() {
  const el = document.getElementById("__ELYSION_DATA__");
  if (!el || !el.textContent) return {};
  try {
    return JSON.parse(el.textContent);
  } catch {
    return {};
  }
}
// Match route by pathname
function matchRoute(pathname) {
  for (const route of routes) {
    if (route.regex.test(pathname)) {
      return route;
    }
  }
  return null;
}
// Hydrate
async function hydrate() {
  const pathname = window.location.pathname;
  const match = matchRoute(pathname);
  if (!match) {
    console.warn("[elysion] No matching route for", pathname);
    return;
  }
  const loaderData = getLoaderData();
  try {
    const mod = await import(match.modulePath + "?t=" + Date.now());
    const pageModule = mod.default;
    if (!pageModule) {
      console.error("[elysion] No default export from", match.modulePath);
      return;
    }
    const rootEl = ${hasRoot ? "document" : "document.documentElement"};
    const element = buildElement(pageModule.component, loaderData, match.routeChain || []);
    hydrateRoot(rootEl, element);
    console.log("[elysion] Hydrated:", match.pattern);
  } catch (err) {
    console.error("[elysion] Hydration error:", err);
  }
}
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", hydrate);
} else {
  hydrate();
}
`;
}

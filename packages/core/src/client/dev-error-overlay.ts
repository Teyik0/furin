interface SourceLocation {
  column: number;
  file: string;
  line: number;
}

interface Diagnostic {
  cause: string | undefined;
  importChain: readonly string[];
  location: SourceLocation | undefined;
  message: string;
  phase: string;
  route: string;
  stack: string | undefined;
}

interface DiagnosticEvent {
  diagnostic: Diagnostic;
  id: number;
  revision: number;
  serverId: string;
  type: "error";
  version: number;
}

interface InitialState {
  basePath: string;
  event: DiagnosticEvent;
}

interface ClientErrorDetail {
  error: unknown;
  phase: "client-render" | "hydrate";
}

interface BrowserDiagnosticEnvelope {
  channel: "diagnostic";
  data: DiagnosticEvent | { id: number; revision: number; serverId: string; type: "ready" };
  version: 1;
}

interface BrowserEventRuntime {
  subscribe: (
    channel: "diagnostic",
    listener: (event: BrowserDiagnosticEnvelope) => void
  ) => () => void;
}

const stateElement = document.querySelector("#__FURIN_DEV_DIAGNOSTIC__");
const initialState = stateElement
  ? (JSON.parse(stateElement.textContent ?? "{}") as InitialState)
  : undefined;
const endpointSuffix = "/_furin/dev/overlay.js";
const blobFramePattern = /blob:https?:\/\/[^\s)]+?(?=:\d+:\d+\)?(?:\n|$))/g;
const sourceMapPattern = /\/\/[#@]\s*sourceMappingURL=([^\s]+)/;
const clientUrl = new URL(import.meta.url);
const inferredBasePath = clientUrl.pathname.endsWith(endpointSuffix)
  ? clientUrl.pathname.slice(0, -endpointSuffix.length)
  : "";
const basePath = initialState?.basePath ?? inferredBasePath;
let currentEvent = initialState?.event;
let coldFailure = initialState !== undefined;
let host: HTMLDivElement | undefined;

function reportFullReload(): void {
  window.dispatchEvent(
    new CustomEvent("furin:hmr", {
      detail: {
        durationMs: null,
        module: null,
        phase: "full-reload",
        reason: "development-error-recovered",
        state: null,
      },
    })
  );
}

function displayLocation(location: SourceLocation | undefined): string {
  return location
    ? `${location.file}:${location.line}:${location.column}`
    : "Application source unavailable";
}

function render(event: DiagnosticEvent): void {
  currentEvent = event;
  host?.remove();
  host = document.createElement("div");
  host.id = "__furin-dev-error-overlay";
  host.setAttribute("role", "alertdialog");
  host.setAttribute("aria-modal", "true");
  host.setAttribute("aria-label", "Furin development error");
  const root = host.attachShadow({ mode: "open" });
  const { diagnostic } = event;
  const location = displayLocation(diagnostic.location);
  root.innerHTML = `
    <style>
      :host{position:fixed;inset:0;z-index:2147483647;color:#f5f2e8;font-family:ui-monospace,SFMono-Regular,Consolas,monospace}
      *{box-sizing:border-box}.backdrop{position:absolute;inset:0;overflow:auto;background:#090a08ee;padding:clamp(20px,5vw,72px)}
      main{max-width:980px;margin:auto;border:1px solid #34362f;border-left:6px solid #ff5d47;background:#11120f;padding:clamp(24px,5vw,56px);box-shadow:0 28px 90px #000}
      .meta{color:#d6ff45;font-size:12px;letter-spacing:.08em;text-transform:uppercase}h1{font:650 clamp(28px,5vw,54px)/1.05 Georgia,serif;overflow-wrap:anywhere}
      [data-furin-diagnostic-location]{display:block;padding:18px 0;border-block:1px solid #34362f;color:#fff;overflow-wrap:anywhere}
      ol{padding-left:24px;color:#c7c5bd}details{margin-top:24px;color:#9d9a91}pre{white-space:pre-wrap;overflow-wrap:anywhere}
    </style>
    <div class="backdrop"><main><div class="meta"></div><h1></h1><code data-furin-diagnostic-location></code><section><ol></ol></section><details><summary>Full stack trace</summary><pre></pre></details></main></div>`;
  const meta = root.querySelector(".meta");
  const title = root.querySelector("h1");
  const locationElement = root.querySelector("[data-furin-diagnostic-location]");
  const imports = root.querySelector("ol");
  const stack = root.querySelector("pre");
  if (meta) {
    meta.textContent = `${diagnostic.phase} · ${diagnostic.route}`;
  }
  if (title) {
    title.textContent = diagnostic.message;
  }
  if (locationElement) {
    locationElement.textContent = location;
  }
  if (imports) {
    for (const path of diagnostic.importChain) {
      const item = document.createElement("li");
      item.textContent = path;
      imports.append(item);
    }
  }
  if (stack) {
    stack.textContent = diagnostic.stack ?? "No stack trace available";
  }
  document.body.append(host);
}

function clear(ready: { revision: number; serverId: string }): void {
  if (!currentEvent) {
    return;
  }
  const serverChanged = ready.serverId !== currentEvent.serverId;
  const revisionAdvanced = ready.revision > currentEvent.revision;
  if (!(serverChanged || revisionAdvanced)) {
    return;
  }
  if (coldFailure || serverChanged) {
    reportFullReload();
    window.location.reload();
    return;
  }
  host?.remove();
  host = undefined;
  currentEvent = undefined;
}

async function stackWithFetchableFrames(stack: string | undefined): Promise<string | undefined> {
  if (!stack) {
    return;
  }
  const blobUrls = [...new Set(stack.match(blobFramePattern) ?? [])];
  let resolved = stack;
  await Promise.all(
    blobUrls.map(async (blobUrl) => {
      const source = await fetch(blobUrl).then((response) => (response.ok ? response.text() : ""));
      const sourceMapReference = sourceMapPattern.exec(source)?.[1];
      if (sourceMapReference) {
        resolved = resolved.replaceAll(
          blobUrl,
          new URL(sourceMapReference, window.location.href).href
        );
      }
    })
  );
  return resolved;
}

async function reportClientError(detail: ClientErrorDetail): Promise<void> {
  const error = detail.error instanceof Error ? detail.error : new Error(String(detail.error));
  const stack = await stackWithFetchableFrames(error.stack);
  const response = await fetch(`${basePath}/_furin/dev/client-errors`, {
    body: JSON.stringify({
      cause: error.cause === undefined ? undefined : String(error.cause),
      message: error.message,
      phase: detail.phase,
      route: window.location.pathname,
      stack,
    }),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
  if (response.ok) {
    coldFailure = false;
    render((await response.json()) as DiagnosticEvent);
  }
}

window.addEventListener("furin:client-error", (event) => {
  const { detail } = event as CustomEvent<ClientErrorDetail>;
  reportClientError(detail).catch(() => undefined);
});

if (currentEvent) {
  render(currentEvent);
}

const browserEvents = (
  window as typeof window & { [key: symbol]: BrowserEventRuntime | undefined }
)[Symbol.for("furin.browser-events.runtime")];
browserEvents?.subscribe("diagnostic", (event) => {
  if (event.data.type === "error") {
    const replaysInitialFailure =
      currentEvent?.serverId === event.data.serverId && currentEvent.id === event.data.id;
    if (!replaysInitialFailure) {
      coldFailure = false;
    }
    render(event.data);
  } else {
    clear(event.data);
  }
});

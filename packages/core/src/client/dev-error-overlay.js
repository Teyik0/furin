const stateElement = document.querySelector("#__FURIN_DEV_ERROR__");
const initialState = stateElement ? JSON.parse(stateElement.textContent || "{}") : {};
const clientUrl = new URL(import.meta.url);
const endpointSuffix = "/_furin/dev/error-overlay.js";
const STACK_POSITION_RE = /(?:at\s+.*?\s+\()?(.+?):(\d+):(\d+)\)?(?:\n|$)/;
const inferredBasePath = clientUrl.pathname.endsWith(endpointSuffix)
  ? clientUrl.pathname.slice(0, -endpointSuffix.length)
  : "";
const state = {
  basePath: initialState.basePath ?? inferredBasePath,
  event: initialState.event ?? null,
};
const cursorKey = `__furin_dev_error_cursor__:${state.basePath}`;

function storedCursor() {
  try {
    const parsed = JSON.parse(sessionStorage.getItem(cursorKey) || "{}");
    return {
      id: Number.isSafeInteger(parsed.id) && parsed.id >= 0 ? parsed.id : 0,
      serverId: typeof parsed.serverId === "string" ? parsed.serverId : null,
    };
  } catch {
    return { id: 0, serverId: null };
  }
}

function rememberEvent(event) {
  try {
    sessionStorage.setItem(cursorKey, JSON.stringify({ id: event.id, serverId: event.serverId }));
  } catch {
    // Cursor persistence is optional.
  }
}

let currentEvent = state.event;
const cursor = storedCursor();
let latestEventId = currentEvent?.id ?? cursor.id;
let latestRevision = currentEvent?.revision ?? 0;
let latestServerId = currentEvent?.serverId ?? cursor.serverId;
let host;
let root;

function ensureHost() {
  if (host && root) {
    return root;
  }
  host = document.createElement("div");
  host.id = "__furin-dev-error-overlay";
  host.setAttribute("role", "alertdialog");
  host.setAttribute("aria-modal", "true");
  host.setAttribute("aria-label", "Furin development error");
  root = host.attachShadow({ mode: "open" });
  document.body.append(host);
  return root;
}

function node(tag, className, text) {
  const element = document.createElement(tag);
  if (className) {
    element.className = className;
  }
  if (text !== undefined && text !== null) {
    element.textContent = String(text);
  }
  return element;
}

function render(event) {
  currentEvent = event;
  const { error } = event;
  const overlayRoot = ensureHost();
  overlayRoot.replaceChildren();

  const style = node("style");
  style.textContent = `
      :host{--ink:#f5f2e8;--muted:#9d9a91;--panel:#11120f;--line:#34362f;--danger:#ff5d47;--signal:#d6ff45;position:fixed;inset:0;z-index:2147483647;color:var(--ink);font-family:"SFMono-Regular",Consolas,"Liberation Mono",monospace}
      *{box-sizing:border-box}
      .backdrop{position:absolute;inset:0;overflow:auto;background:radial-gradient(circle at 82% 12%,#31201b 0,transparent 31%),repeating-linear-gradient(90deg,transparent 0,transparent 47px,#ffffff08 48px),#090a08;padding:clamp(18px,4vw,64px)}
      .shell{width:min(1040px,100%);margin:0 auto;border:1px solid var(--line);border-left:6px solid var(--danger);background:linear-gradient(145deg,#171814 0%,var(--panel) 58%);box-shadow:0 28px 90px #000}
      .top{display:flex;align-items:center;justify-content:space-between;gap:24px;padding:16px 20px;border-bottom:1px solid var(--line);background:#0d0e0b}
      .brand,.revision,.label{font-size:11px;letter-spacing:.14em;text-transform:uppercase}
      .brand{color:var(--danger);font-weight:800}.revision{color:var(--muted)}
      .content{padding:clamp(24px,5vw,64px)}
      .meta{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:30px}
      .tag{border:1px solid var(--line);padding:7px 10px;color:var(--signal);font-size:12px}
      h1{max-width:850px;margin:0 0 32px;font:650 clamp(28px,5vw,58px)/1.02 Georgia,serif;letter-spacing:-.035em;overflow-wrap:anywhere}
      .location{display:grid;grid-template-columns:auto 1fr;gap:12px 22px;padding:18px 0;border-block:1px solid var(--line)}
      .label{color:var(--muted)}.value{font-size:13px;overflow-wrap:anywhere}
      .cause{margin-top:24px;padding:18px;border-left:2px solid var(--danger);background:#ff5d470d}
      .cause strong{display:block;margin-bottom:8px;color:var(--danger);font-size:11px;letter-spacing:.12em;text-transform:uppercase}
      .imports{margin-top:28px}.imports ol{margin:12px 0 0;padding:0;list-style:none;counter-reset:imports}
      .imports li{counter-increment:imports;display:grid;grid-template-columns:28px 1fr;gap:8px;padding:8px 0;color:#c7c5bd;font-size:12px;overflow-wrap:anywhere}
      .imports li::before{content:counter(imports,decimal-leading-zero);color:#64675c}
      details{margin-top:28px;border-top:1px solid var(--line);padding-top:18px}summary{cursor:pointer;color:var(--muted);font-size:12px}
      pre{margin:16px 0 0;overflow:auto;white-space:pre-wrap;color:#b9b7af;font:12px/1.65 inherit}
      .actions{display:flex;align-items:center;gap:18px;margin-top:36px}
      button{border:0;background:var(--signal);color:#111;padding:12px 18px;font:800 12px/1 inherit;letter-spacing:.08em;text-transform:uppercase;cursor:pointer}
      button:hover{filter:brightness(1.12)}button:focus-visible{outline:2px solid white;outline-offset:3px}
      .status{color:var(--muted);font-size:11px}
      @media(max-width:600px){.location{grid-template-columns:1fr;gap:5px}.value{margin-bottom:10px}.content{padding:24px 18px}}
      @media(prefers-reduced-motion:no-preference){.shell{animation:enter .18s ease-out}@keyframes enter{from{opacity:0;transform:translateY(8px)}}}
    `;

  const backdrop = node("div", "backdrop");
  const shell = node("main", "shell");
  const top = node("header", "top");
  top.append(
    node("span", "brand", "Furin / development fault"),
    node("span", "revision", `revision ${event.revision}`)
  );

  const content = node("section", "content");
  const meta = node("div", "meta");
  meta.append(node("span", "tag", error.phase), node("span", "tag", `route ${error.route}`));
  content.append(meta, node("h1", "", error.message));

  const location = node("div", "location");
  location.append(
    node("span", "label", "source"),
    node(
      "span",
      "value",
      `${error.file || "unknown"}${error.line ? `:${error.line}:${error.column || 1}` : ""}`
    ),
    node("span", "label", "phase"),
    node("span", "value", error.phase)
  );
  content.append(location);

  if (error.cause) {
    const cause = node("div", "cause");
    cause.append(node("strong", "", "Caused by"), node("span", "", error.cause));
    content.append(cause);
  }

  if (error.importChain.length > 0) {
    const imports = node("section", "imports");
    imports.append(node("span", "label", "Import chain"));
    const list = node("ol");
    for (const path of error.importChain) {
      list.append(node("li", "", path));
    }
    imports.append(list);
    content.append(imports);
  }

  if (error.stack) {
    const details = node("details");
    details.append(node("summary", "", "Full stack trace"), node("pre", "", error.stack));
    content.append(details);
  }

  const actions = node("div", "actions");
  const retry = node("button", "", "Retry route");
  retry.type = "button";
  retry.addEventListener("click", () => window.location.reload());
  actions.append(retry, node("span", "status", "Waiting for a successful compilation…"));
  content.append(actions);

  shell.append(top, content);
  backdrop.append(shell);
  overlayRoot.append(style, backdrop);
  retry.focus();
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function sourcePosition(error) {
  if (!(error instanceof Error && error.stack)) {
    return { column: null, file: null, line: null };
  }
  const match = STACK_POSITION_RE.exec(error.stack);
  return {
    column: match ? Number.parseInt(match[3], 10) : null,
    file: match?.[1] ?? null,
    line: match ? Number.parseInt(match[2], 10) : null,
  };
}

function renderHydrationError(value) {
  const error = value instanceof Error ? value : new Error(String(value));
  const position = sourcePosition(error);
  render({
    error: {
      cause: error.cause === undefined ? null : errorMessage(error.cause),
      column: position.column,
      file: position.file,
      importChain: position.file ? [position.file] : [],
      line: position.line,
      message: error.message,
      phase: "hydrate",
      route: window.location.pathname,
      stack: error.stack ?? null,
    },
    id: latestEventId,
    revision: latestRevision,
    serverId: latestServerId ?? "client",
    type: "error",
    version: 1,
  });
}

function connect() {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  const socket = new WebSocket(
    `${protocol}//${window.location.host}${state.basePath}/_furin/dev/errors?after=${latestEventId}&server=${encodeURIComponent(latestServerId ?? "")}`
  );
  socket.addEventListener("message", (message) => {
    const event = JSON.parse(String(message.data));
    if (event.version !== 1) {
      return;
    }
    latestEventId = event.id;
    latestRevision = event.revision;
    latestServerId = event.serverId;
    rememberEvent(event);
    if (
      event.type === "ready" &&
      currentEvent &&
      (event.serverId !== currentEvent.serverId || event.revision > currentEvent.revision)
    ) {
      window.location.reload();
      return;
    }
    if (event.type === "error") {
      render(event);
    }
  });
  socket.addEventListener("close", () => window.setTimeout(connect, 500));
}

window.addEventListener("furin:hydrate-error", (event) => {
  renderHydrationError(event.detail);
});

if (currentEvent) {
  render(currentEvent);
}
connect();

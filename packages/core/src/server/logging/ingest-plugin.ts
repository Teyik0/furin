import { Elysia, problem } from "elysia";
import type { DrainContext, LoggerConfig } from "evlog";
import { readBoundedBytes } from "../bounded-body.ts";
import { instrumentationLoggerExclusions } from "../devtools/instrumentation.ts";
import { createFurinEvlog, type FurinEvlogOptions, setFurinEvlogOptions } from "../evlog.ts";
import type { FurinInstance } from "../instance.ts";
import { initializeFurinLogger } from "../logger.ts";

const MAX_BROWSER_INGEST_BYTES = 64 * 1024;
const MAX_BROWSER_INGEST_EVENTS = 100;

export type FurinLoggerOptions = FurinEvlogOptions & Pick<LoggerConfig, "sampling">;

const PROTOTYPE_POLLUTION_KEYS = new Set(["__proto__", "constructor", "prototype"]);

/** Drops prototype-pollution keys at every depth before evlog deep-merges the event. */
function dropPrototypeKeys(key: string, value: unknown): unknown {
  return PROTOTYPE_POLLUTION_KEYS.has(key) ? undefined : value;
}

type BrowserIngestRead =
  | { body: unknown; kind: "ok" }
  | { kind: "invalid" }
  | { kind: "oversized" };

async function readBrowserIngest(request: Request): Promise<BrowserIngestRead> {
  const contentLength = request.headers.get("content-length");
  if (contentLength) {
    const declaredBytes = Number(contentLength);
    if (Number.isFinite(declaredBytes) && declaredBytes > MAX_BROWSER_INGEST_BYTES) {
      await request.body?.cancel();
      return { kind: "oversized" };
    }
  }
  if (request.body === null) {
    return { kind: "invalid" };
  }
  const bytes = await readBoundedBytes(request.body, MAX_BROWSER_INGEST_BYTES);
  if (bytes === undefined) {
    return { kind: "oversized" };
  }
  try {
    return { body: JSON.parse(new TextDecoder().decode(bytes), dropPrototypeKeys), kind: "ok" };
  } catch {
    return { kind: "invalid" };
  }
}

function createLoggerOptions(
  prefix: string,
  syncPath: string | undefined,
  logger: FurinEvlogOptions
): FurinEvlogOptions {
  const { exclude: userExclude, ...evlogOptions } = logger;
  return {
    ...evlogOptions,
    // Exclude patterns match the PHYSICAL request path — prefix them.
    exclude: [
      `${prefix}/_client/**`,
      `${prefix}/public/**`,
      `${prefix}/favicon.ico`,
      `${prefix}/_bun_hmr_entry/**`,
      ...instrumentationLoggerExclusions(prefix),
      ...(syncPath ? [`${prefix}${syncPath}/**`] : []),
      // Note: `?_furin=data` is logged with the logical page path, so SPA navigations
      // appear as "GET /board/123 200" — same shape as a normal SSR nav.
      // /_furin/ingest remains loggable when browser logging is explicitly
      // enabled so browser-side events show up.
      // evlog's `matchesPattern` only supports `*`, `**`, `?` — extglob
      // like `!(...)` matches nothing, so don't add patterns relying on it.
      ...(userExclude ?? []),
    ],
  };
}

/** Evlog wide-event plugin + browser log ingest endpoint for one runtime. */
export function createLoggerPlugin(
  instance: FurinInstance,
  logger: FurinLoggerOptions | undefined,
  clientLogging: boolean
) {
  const { sampling, ...elysiaLoggerOptions } = logger ?? {};
  initializeFurinLogger({
    env: { service: "furin" },
    ...(sampling ? { sampling } : {}),
  });
  const options = createLoggerOptions(instance.prefix, instance.syncPath, elysiaLoggerOptions);
  setFurinEvlogOptions(instance, options);
  const app = new Elysia().use(createFurinEvlog(options));

  if (!clientLogging) {
    return app;
  }

  return app.post("/_furin/ingest", { parse: "none" }, async ({ log, request, status }) => {
    const parsed = await readBrowserIngest(request);
    if (parsed.kind === "oversized") {
      return problem(413, { detail: "Browser event payload exceeds 64 KiB." });
    }
    if (parsed.kind === "invalid") {
      return problem("Bad Request", { detail: "Browser event payload must be valid JSON." });
    }
    const { body } = parsed;
    if (!Array.isArray(body)) {
      return problem("Bad Request", { detail: "Browser event payload must be a JSON array." });
    }
    const batch = (body as DrainContext[]).slice(0, MAX_BROWSER_INGEST_EVENTS);
    for (const entry of batch) {
      if (!entry || typeof entry !== "object" || !("event" in entry)) {
        log.set({ msg: "[furin] ingest: skipping malformed entry" });
        continue;
      }
      const { event } = entry;
      if (!event || typeof event !== "object") {
        continue;
      }
      // Nest browser input under one key so it cannot overwrite server fields
      // (status, path, environment, user, ...).
      log.set({ browser: event, service: "furin:browser" });
    }
    return status("No Content");
  }) as unknown as Elysia;
}

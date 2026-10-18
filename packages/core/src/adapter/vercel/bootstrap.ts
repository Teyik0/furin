// Lightweight `__server.func/index.js`: starts loading the handler bundle at
// module init and reports cold-start timings without evaluating it first.
import { VERCEL_DATA_FILE, type VercelRuntimeData } from "./data.ts";

interface HandlerModule {
  default: { fetch: (request: Request) => Promise<Response> };
  initialization: { app_count: number; route_count: number; server_init_ms: number };
}

const moduleInitStartedAt = performance.now();
const handlerPromise = (import("./handler.js") as Promise<HandlerModule>).then((handlerModule) => ({
  handlerModule,
  moduleInitMs: Math.round((performance.now() - moduleInitStartedAt) * 100) / 100,
}));
let firstRequest = true;

function appendServerTiming(response: Response, value: string): Response {
  try {
    response.headers.append("server-timing", value);
    return response;
  } catch {
    if (response.status === 101) {
      return response;
    }
    const headers = new Headers(response.headers);
    headers.append("server-timing", value);
    return new Response(response.body, {
      headers,
      status: response.status,
      statusText: response.statusText,
    });
  }
}

async function logColdStart(
  ready: Awaited<typeof handlerPromise>,
  requestWaitMs: number
): Promise<void> {
  const { serverBundleBytes } = (await Bun.file(
    new URL(`./${VERCEL_DATA_FILE}`, import.meta.url)
  ).json()) as VercelRuntimeData;
  const { initialization } = ready.handlerModule;
  console.log(
    JSON.stringify({
      environment: process.env.VERCEL_ENV ?? "production",
      event: "vercel_cold_start",
      furin: {
        app_count: initialization.app_count,
        module_init_ms: ready.moduleInitMs,
        request_wait_ms: requestWaitMs,
        route_count: initialization.route_count,
        server_bundle_bytes: serverBundleBytes,
        server_init_ms: initialization.server_init_ms,
      },
      level: "info",
      region: process.env.VERCEL_REGION,
      service: "furin",
    })
  );
}

async function handle(request: Request): Promise<Response> {
  const waitStartedAt = performance.now();
  const ready = await handlerPromise;
  const requestWaitMs = Math.round((performance.now() - waitStartedAt) * 100) / 100;
  const isFirstRequest = firstRequest;
  firstRequest = false;
  if (isFirstRequest) {
    await logColdStart(ready, requestWaitMs);
  }

  const handlerStartedAt = performance.now();
  const response = await ready.handlerModule.default.fetch(request);
  const handlerMs = Math.round((performance.now() - handlerStartedAt) * 100) / 100;
  const serverTiming = [
    `furin_module_init;dur=${ready.moduleInitMs}`,
    `furin_server_init;dur=${ready.handlerModule.initialization.server_init_ms}`,
    `furin_handler_wait;dur=${requestWaitMs}`,
    `furin_handler;dur=${handlerMs}`,
    ...(isFirstRequest ? ["furin_instance_first_request"] : []),
  ].join(", ");
  return appendServerTiming(response, serverTiming);
}

export default { fetch: handle };

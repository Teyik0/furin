import { buildRouteFrameTemplate } from "../server/render/assemble.ts";

interface TransportMetrics {
  browserScriptUnits: number;
  compressedBytes: number;
  encodeMs: number;
  memoryBytes: number;
}

export interface TransportBenchmarkResult {
  composites: number;
  script: TransportMetrics;
  template: TransportMetrics;
  winner: "script" | "template";
}

function encodeTemplate(payloads: readonly string[]): string {
  return buildRouteFrameTemplate(payloads.join("\n"));
}

function stringifyScriptJson(value: string): string {
  return JSON.stringify(value).replace(/[<>&]/g, (char) => {
    if (char === "<") {
      return "\\u003C";
    }
    if (char === ">") {
      return "\\u003E";
    }
    return "\\u0026";
  });
}

function encodeScripts(payloads: readonly string[]): string {
  return payloads
    .map(
      (payload) =>
        `<script>self.__FURIN_RSC__=self.__FURIN_RSC__||[];self.__FURIN_RSC__.push(${stringifyScriptJson(payload)})</script>`
    )
    .join("");
}

function measure(
  encoder: (payloads: readonly string[]) => string,
  payloads: readonly string[],
  browserScriptUnits: number
): TransportMetrics {
  const started = performance.now();
  const encoded = encoder(payloads);
  const encodeMs = performance.now() - started;
  const bytes = new TextEncoder().encode(encoded);
  return {
    browserScriptUnits,
    compressedBytes: Bun.gzipSync(bytes).byteLength,
    encodeMs,
    memoryBytes: bytes.byteLength,
  };
}

export function benchmarkRscTransport(
  flightPayload: string,
  composites: number
): TransportBenchmarkResult {
  const payloads = Array.from({ length: composites }, (_, index) => `${index}:${flightPayload}`);
  const template = measure(encodeTemplate, payloads, 0);
  const script = measure(encodeScripts, payloads, composites);
  const templateWithinBudget = template.compressedBytes <= script.compressedBytes * 1.05;
  return {
    composites,
    script,
    template,
    winner: templateWithinBudget ? "template" : "script",
  };
}

import { existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { isProductionBuild } from "../shared/production-build.ts";
import { drainFlight, type FlightRenderSession } from "./flight-drain.ts";
import type { RscRenderOperation } from "./render-error.ts";

interface ServerCodec {
  renderFlight: (model: unknown, signal: AbortSignal | undefined) => FlightRenderSession;
}

const serverCodecPromises = new Map<"development" | "production", Promise<ServerCodec>>();

export function resolveConfiguredCodecPath(configuredPath: string | undefined): string | undefined {
  if (configuredPath === undefined || configuredPath.trim() === "") {
    return;
  }
  const codecPath = isAbsolute(configuredPath) ? configuredPath : resolve(configuredPath);
  return existsSync(codecPath) ? codecPath : undefined;
}

export function resolveBuiltCodecPath(
  moduleDir: string,
  executablePath: string | undefined
): string | undefined {
  const candidates = [join(moduleDir, "server-codec.js")];
  if (executablePath !== undefined && executablePath.trim() !== "") {
    candidates.push(join(dirname(executablePath), "server-codec.js"));
  }
  return candidates.find((candidate) => existsSync(candidate));
}

function loadServerCodec(): Promise<ServerCodec> {
  const mode = isProductionBuild() ? "production" : "development";
  const existing = serverCodecPromises.get(mode);
  if (existing !== undefined) {
    return existing;
  }

  const codecPromise = (async () => {
    const configuredCodecPath = resolveConfiguredCodecPath(process.env.FURIN_RSC_CODEC_PATH);
    if (configuredCodecPath !== undefined) {
      return import(pathToFileURL(configuredCodecPath).href) as Promise<ServerCodec>;
    }
    const builtCodecPath = resolveBuiltCodecPath(import.meta.dir, process.execPath);
    if (builtCodecPath !== undefined) {
      return import(pathToFileURL(builtCodecPath).href) as Promise<ServerCodec>;
    }
    const outdir = join(tmpdir(), `furin-rsc-${process.pid}-${Bun.hash(import.meta.url)}-${mode}`);
    mkdirSync(outdir, { recursive: true });
    const sourcePath = join(import.meta.dir, "server-codec.ts");
    if (!existsSync(sourcePath)) {
      throw new Error(
        "[furin/rsc] The isolated Flight codec artifact is missing. Rebuild the application with the Furin Bun adapter."
      );
    }
    const result = await Bun.build({
      conditions: ["react-server"],
      define: { "process.env.NODE_ENV": JSON.stringify(mode) },
      entrypoints: [sourcePath],
      format: "esm",
      minify: false,
      outdir,
      sourcemap: "none",
      target: "bun",
    });
    if (!result.success || result.outputs.length !== 1) {
      const details = result.logs.map((log) => log.message).join("\n");
      throw new Error(`[furin/rsc] Failed to build the isolated RSC codec graph.\n${details}`);
    }
    const [output] = result.outputs;
    if (output === undefined) {
      throw new Error("[furin/rsc] Isolated RSC codec build produced no output.");
    }
    return import(pathToFileURL(output.path).href) as Promise<ServerCodec>;
  })();

  serverCodecPromises.set(mode, codecPromise);
  return codecPromise;
}

export async function encodeFlight(
  model: unknown,
  signal: AbortSignal | undefined,
  operation: RscRenderOperation
): Promise<Uint8Array> {
  const codec = await loadServerCodec();
  return drainFlight(codec.renderFlight(model, signal), operation);
}

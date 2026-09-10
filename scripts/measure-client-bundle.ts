import { isAbsolute, resolve } from "node:path";
import type { PerformanceReport } from "./compare-performance-reports.ts";

interface ClientOutput {
  gzipBytes: number;
  metadata: Bun.BuildMetafile["outputs"][string];
  path: string;
  rawBytes: number;
}

const CLIENT_OUTPUT_RE = /\.(?:css|js)$/;
const formatter = new Intl.NumberFormat("en-US", {
  maximumFractionDigits: 1,
  minimumFractionDigits: 1,
});

function formatKilobytes(bytes: number): string {
  return `${formatter.format(bytes / 1024)} KiB`;
}

function isClientOutput(path: string): boolean {
  return CLIENT_OUTPUT_RE.test(path);
}

function resolveOutputPath(directory: string, outputPath: string): string {
  return isAbsolute(outputPath) ? outputPath : resolve(directory, outputPath);
}

async function measureOutput(
  directory: string,
  path: string,
  metadata: Bun.BuildMetafile["outputs"][string]
): Promise<ClientOutput> {
  const filePath = resolveOutputPath(directory, path);
  const file = Bun.file(filePath);
  if (!(await file.exists())) {
    throw new Error(`Bundle output not found: ${filePath}`);
  }
  const bytes = new Uint8Array(await file.arrayBuffer());
  return {
    gzipBytes: Bun.gzipSync(bytes).byteLength,
    metadata,
    path,
    rawBytes: metadata.bytes,
  };
}

function printUsage(): void {
  console.error(
    "Usage: bun scripts/measure-client-bundle.ts <path-to-metafile.json> <path-to-client-output> [--json <report.json>] [--server-binary <path>]"
  );
}

function readOption(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index === -1) {
    return;
  }
  const value = args[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`${name} requires a value`);
  }
  return value;
}

function collectInitialOutputs(
  bundleMetafile: Bun.BuildMetafile,
  rootEntrypoints: string[]
): Set<string> {
  const initialOutputs = new Set<string>();
  const visit = (path: string): void => {
    if (initialOutputs.has(path)) {
      return;
    }
    const metadata = bundleMetafile.outputs[path];
    if (metadata === undefined) {
      return;
    }
    initialOutputs.add(path);
    if (metadata.cssBundle !== undefined) {
      visit(metadata.cssBundle);
    }
    for (const imported of metadata.imports) {
      if (imported.kind !== "dynamic-import") {
        visit(imported.path);
      }
    }
  };
  for (const entry of rootEntrypoints) {
    visit(entry);
  }
  return initialOutputs;
}

const [, , metafilePath, clientOutputDir, ...options] = Bun.argv;

if (metafilePath === undefined || clientOutputDir === undefined) {
  printUsage();
  process.exit(1);
}

let jsonPath: string | undefined;
let serverBinaryPath: string | undefined;
try {
  jsonPath = readOption(options, "--json");
  serverBinaryPath = readOption(options, "--server-binary");
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
if ((jsonPath === undefined) !== (serverBinaryPath === undefined)) {
  console.error("--json and --server-binary must be provided together");
  process.exit(1);
}

const metafileFile = Bun.file(metafilePath);
if (!(await metafileFile.exists())) {
  console.error(`Client metafile not found: ${metafilePath}`);
  process.exit(1);
}

const metafile = (await metafileFile.json()) as Bun.BuildMetafile;
const outputEntries = Object.entries(metafile.outputs)
  .filter(([path]) => isClientOutput(path))
  .toSorted(([left], [right]) => left.localeCompare(right));

if (outputEntries.length === 0) {
  console.error(`No client JS or CSS outputs found in: ${metafilePath}`);
  process.exit(1);
}

const importedOutputKinds = new Map<string, Bun.ImportKind>();
const lazyEntrypoints = new Set<string>();
for (const [, metadata] of outputEntries) {
  for (const imported of metadata.imports) {
    if (imported.kind === "dynamic-import") {
      lazyEntrypoints.add(imported.path);
    }
    if (imported.kind === "dynamic-import" || !importedOutputKinds.has(imported.path)) {
      importedOutputKinds.set(imported.path, imported.kind);
    }
  }
}

const outputs = await Promise.all(
  outputEntries.map(([path, metadata]) => measureOutput(clientOutputDir, path, metadata))
);
const entrypoints = outputEntries
  .filter(
    ([path, metadata]) =>
      path.endsWith(".js") && metadata.entryPoint !== undefined && !lazyEntrypoints.has(path)
  )
  .map(([path]) => path);
if (entrypoints.length === 0) {
  console.error(`No client entrypoint found in: ${metafilePath}`);
  process.exit(1);
}
const initialOutputs = collectInitialOutputs(metafile, entrypoints);
const totals = outputs.reduce(
  (current, output) => ({
    gzipBytes: current.gzipBytes + output.gzipBytes,
    rawBytes: current.rawBytes + output.rawBytes,
  }),
  { gzipBytes: 0, rawBytes: 0 }
);

for (const output of outputs) {
  const importedAs = importedOutputKinds.get(output.path);
  let kind = initialOutputs.has(output.path) ? "entry" : "chunk";
  if (!initialOutputs.has(output.path) && importedAs === "dynamic-import") {
    kind = "lazy";
  }
  console.log(
    `${output.path} [${kind}]  raw=${formatKilobytes(output.rawBytes)}  gzip=${formatKilobytes(output.gzipBytes)}`
  );

  const contributingInputs = Object.entries(output.metadata.inputs)
    .toSorted(([, left], [, right]) => right.bytesInOutput - left.bytesInOutput)
    .slice(0, 5);
  for (const [inputPath, input] of contributingInputs) {
    console.log(`  ${formatKilobytes(input.bytesInOutput)}  ${inputPath}`);
  }
  for (const imported of output.metadata.imports) {
    console.log(`  ${imported.kind} → ${imported.path}`);
  }
}

console.log(
  `total  raw=${formatKilobytes(totals.rawBytes)}  gzip=${formatKilobytes(totals.gzipBytes)}`
);

if (jsonPath !== undefined && serverBinaryPath !== undefined) {
  const serverBinary = Bun.file(serverBinaryPath);
  if (!(await serverBinary.exists())) {
    console.error(`Server binary not found: ${serverBinaryPath}`);
    process.exit(1);
  }
  const sumGzip = (extension: ".css" | ".js"): number =>
    outputs
      .filter((output) => initialOutputs.has(output.path) && output.path.endsWith(extension))
      .reduce((total, output) => total + output.gzipBytes, 0);
  const lazyChunkSizes = outputs
    .filter((output) => !initialOutputs.has(output.path) && output.path.endsWith(".js"))
    .map((output) => output.gzipBytes);
  const report: PerformanceReport = {
    metrics: {
      initialCssGzipBytes: sumGzip(".css"),
      initialJavaScriptGzipBytes: sumGzip(".js"),
      largestLazyChunkGzipBytes: Math.max(0, ...lazyChunkSizes),
      serverBinaryBytes: serverBinary.size,
      totalClientGzipBytes: totals.gzipBytes,
    },
    schemaVersion: 1,
  };
  await Bun.write(jsonPath, `${JSON.stringify(report, null, 2)}\n`);
}

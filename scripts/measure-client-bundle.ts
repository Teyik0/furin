import { isAbsolute, resolve } from "node:path";

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
    "Usage: bun scripts/measure-client-bundle.ts <path-to-metafile.json> <path-to-client-output>"
  );
}

const [, , metafilePath, clientOutputDir] = Bun.argv;

if (metafilePath === undefined || clientOutputDir === undefined) {
  printUsage();
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
for (const [, metadata] of outputEntries) {
  for (const imported of metadata.imports) {
    if (imported.kind === "dynamic-import" || !importedOutputKinds.has(imported.path)) {
      importedOutputKinds.set(imported.path, imported.kind);
    }
  }
}

const outputs = await Promise.all(
  outputEntries.map(([path, metadata]) => measureOutput(clientOutputDir, path, metadata))
);
const totals = outputs.reduce(
  (current, output) => ({
    gzipBytes: current.gzipBytes + output.gzipBytes,
    rawBytes: current.rawBytes + output.rawBytes,
  }),
  { gzipBytes: 0, rawBytes: 0 }
);

for (const output of outputs) {
  const importedAs = importedOutputKinds.get(output.path);
  let kind = "entry";
  if (importedAs === "dynamic-import") {
    kind = "lazy";
  } else if (importedAs !== undefined) {
    kind = "chunk";
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

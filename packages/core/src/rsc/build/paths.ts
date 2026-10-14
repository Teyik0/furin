import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SOURCE_DIR = dirname(fileURLToPath(import.meta.resolve("@teyik0/furin/rsc")));

export const CLIENT_REFERENCE_RUNTIME_PATH = join(SOURCE_DIR, "rsc/client-references.ts");
export const BUNDLED_CLIENT_CODEC_PATH = join(SOURCE_DIR, "rsc/bundled-client-codec.ts");

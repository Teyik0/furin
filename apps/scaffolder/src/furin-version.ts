// `bun build` inlines this value, so a published scaffolder keeps the Furin
// version it was released with instead of a hand-maintained pin.
import { version } from "../../../packages/core/package.json";

/** The @teyik0/furin release this scaffolder was built alongside. */
export const BUNDLED_FURIN_VERSION = version;

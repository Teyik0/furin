import type { HeadOptions } from "../../client.ts";
import { extractTitle } from "./shell.ts";

const MAX_NAVIGATION_HEAD_BYTES = 64 * 1024;

/**
 * Returns a copy of `syncData` carrying the reserved `__furinHead` /
 * `__furinTitle` fields for `headOptions`. `head()` never executes in the
 * browser, so this is the only channel through which SPA navigation learns the
 * new document head. Oversized or unserialisable metadata is dropped rather
 * than breaking the navigation payload.
 */
export function withNavigationHead(
  syncData: { [key: string]: unknown },
  headOptions: HeadOptions | undefined
): { [key: string]: unknown } {
  if (headOptions === undefined) {
    return syncData;
  }
  const title = extractTitle(headOptions.meta);
  let includeHead = false;
  try {
    includeHead =
      new TextEncoder().encode(JSON.stringify(headOptions)).byteLength <= MAX_NAVIGATION_HEAD_BYTES;
  } catch {
    // Invalid or cyclic metadata must not break an otherwise valid navigation.
  }
  return {
    ...syncData,
    ...(includeHead ? { __furinHead: headOptions } : {}),
    ...(title === undefined ? {} : { __furinTitle: title }),
  };
}

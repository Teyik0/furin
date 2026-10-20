import type { CacheTag } from "../../furin.ts";
import type { RevalidateType } from "../cache/route-cache.ts";

export type InvalidationRule =
  | {
      path: string;
      tags?: readonly CacheTag[];
      type: RevalidateType;
    }
  | {
      path?: never;
      tags: readonly CacheTag[];
      type?: never;
    };

export type InvalidationInput = InvalidationRule | readonly InvalidationRule[];

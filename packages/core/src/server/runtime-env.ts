/**
 * Default mode for runtimes created afterwards and for code bound to no
 * runtime (the default state bucket, standalone `furinSync()`). Each runtime
 * fixes its own mode when `furin()` creates it (`FurinInstance.development`).
 */
export let IS_DEV = process.env.NODE_ENV !== "production";

/** @internal test-only — changes the default mode for runtimes created afterwards */
export function __setDevMode(val: boolean): void {
  IS_DEV = val;
}

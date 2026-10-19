type BunBuild = typeof Bun.build;

type BunBuildGlobal = typeof globalThis & {
  __FURIN_BUN_BUILD_FOR_TESTS?: BunBuild;
};

/** Inlines production mode so dev-only branches (HMR, jsxDEV) are compiled out. */
export const PRODUCTION_DEFINE = { "process.env.NODE_ENV": JSON.stringify("production") };

export function runBunBuild(config: Bun.BuildConfig): ReturnType<BunBuild> {
  return (((globalThis as BunBuildGlobal).__FURIN_BUN_BUILD_FOR_TESTS ?? Bun.build) as BunBuild)(
    config
  );
}

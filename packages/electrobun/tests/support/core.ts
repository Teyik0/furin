// Core source modules reused by these tests, loaded at runtime only: their
// import graph reaches Furin's browser modules, which this Bun-only package
// does not type-check.
const appFixturesModule: string = "../../../core/tests/support/app-fixtures.ts";
const cliConfigModule: string = "../../../core/src/cli/config.ts";

export const {
  createTmpApp,
  writeAppFile,
}: {
  createTmpApp: (fixtureName: string) => { cleanup: () => void; path: string };
  writeAppFile: (appPath: string, relativePath: string, contents: string) => void;
} = await import(appFixturesModule);

export const { loadCliConfig }: { loadCliConfig: (cwd: string) => Promise<{ desktop?: unknown }> } =
  await import(cliConfigModule);

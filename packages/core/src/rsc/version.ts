import React from "react";
import { version as reactDomVersion } from "react-dom";

const STABLE_REACT_VERSION = /^(\d+)\.(\d+)\.(\d+)$/;
const MINIMUM_REACT_19_PATCH = new Map([
  [0, 6],
  [1, 7],
  [2, 6],
  [3, 0],
]);

export interface RscVersions {
  react: string;
  reactDom: string;
  reactServerDom: string;
}

export function assertCompatibleRscVersions(versions: RscVersions): void {
  if (versions.react !== versions.reactDom || versions.react !== versions.reactServerDom) {
    throw new Error(
      "[furin/rsc] React package versions must match exactly: " +
        `react=${versions.react}, react-dom=${versions.reactDom}, ` +
        `react-server-dom-webpack=${versions.reactServerDom}.`
    );
  }
  const match = STABLE_REACT_VERSION.exec(versions.react);
  // biome-ignore lint/suspicious/noUnnecessaryConditions: exec returns null for unsupported versions.
  const major = Number(match?.[1]);
  // biome-ignore lint/suspicious/noUnnecessaryConditions: exec returns null for unsupported versions.
  const minor = Number(match?.[2]);
  // biome-ignore lint/suspicious/noUnnecessaryConditions: exec returns null for unsupported versions.
  const patch = Number(match?.[3]);
  const minimumPatch = MINIMUM_REACT_19_PATCH.get(minor);
  // biome-ignore lint/suspicious/noUnnecessaryConditions: exec returns null for unsupported versions.
  if (!match || major !== 19 || minimumPatch === undefined || patch < minimumPatch) {
    throw new Error("[furin/rsc] RSC requires a supported patched React 19 version.");
  }
}

let checked: Promise<void> | undefined;

export function assertInstalledRscVersions(): Promise<void> {
  if (checked !== undefined) {
    return checked;
  }
  checked = (async () => {
    const packageUrl = new URL(
      "./package.json",
      import.meta.resolve("react-server-dom-webpack/server.edge")
    );
    const metadata = (await Bun.file(packageUrl).json()) as { version?: unknown };
    if (typeof metadata.version !== "string") {
      throw new Error("[furin/rsc] Cannot determine the installed Flight codec version.");
    }
    assertCompatibleRscVersions({
      react: React.version,
      reactDom: reactDomVersion,
      reactServerDom: metadata.version,
    });
  })();
  return checked;
}

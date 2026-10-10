import { appendFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const PACKAGES = [
  { prefix: "v", directory: "packages/core", name: "@teyik0/furin" },
  { prefix: "electrobun-v", directory: "packages/electrobun", name: "@teyik0/furin-electrobun" },
  { prefix: "create-furin-v", directory: "apps/scaffolder", name: "create-furin" },
] as const;

// Canonical SemVer 2.0.0, including prerelease and build metadata.
const VERSION =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

export interface ReleaseTarget {
  directory: string;
  distTag: "latest" | "next";
  name: string;
  version: string;
}

function object(value: unknown): value is { [key: string]: unknown } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function resolveReleaseTarget(event: unknown, root: string): Promise<ReleaseTarget> {
  if (
    !(object(event) && object(event.release)) ||
    typeof event.release.tag_name !== "string" ||
    typeof event.release.prerelease !== "boolean"
  ) {
    throw new Error("Expected a published GitHub release event.");
  }
  const tag = event.release.tag_name;
  const target = PACKAGES.find((candidate) => tag.startsWith(candidate.prefix));
  if (!target) {
    throw new Error(`Unsupported release tag: ${tag}`);
  }
  const version = tag.slice(target.prefix.length);
  if (!VERSION.test(version)) {
    throw new Error(`Invalid release version: ${version}`);
  }
  const prerelease = version.split("+")[0]?.includes("-") === true;
  if (prerelease !== event.release.prerelease) {
    throw new Error("GitHub prerelease status must match the package version.");
  }
  const manifest: { name?: string; version?: string } = await Bun.file(
    join(root, target.directory, "package.json")
  ).json();
  if (manifest.name !== target.name || manifest.version !== version) {
    throw new Error(`Release tag must match ${target.directory}/package.json name and version.`);
  }
  return {
    directory: target.directory,
    name: target.name,
    version,
    distTag: prerelease ? "next" : "latest",
  };
}

export async function verifyReleasePrerequisites(
  target: ReleaseTarget,
  root: string,
  registry: string
): Promise<void> {
  if (target.name !== "@teyik0/furin-electrobun") {
    return;
  }
  const manifest: unknown = await Bun.file(join(root, target.directory, "package.json")).json();
  const range =
    object(manifest) && object(manifest.peerDependencies)
      ? manifest.peerDependencies["@teyik0/furin"]
      : undefined;
  if (typeof range !== "string" || !range) {
    throw new Error("Electrobun must declare its compatible @teyik0/furin peer range.");
  }
  const response = await fetch(
    new URL(
      encodeURIComponent("@teyik0/furin"),
      registry.endsWith("/") ? registry : `${registry}/`
    ),
    {
      headers: { accept: "application/vnd.npm.install-v1+json" },
      signal: AbortSignal.timeout(15_000),
    }
  );
  if (!response.ok) {
    await response.arrayBuffer();
    throw new Error(`Cannot verify published core versions: registry HTTP ${response.status}.`);
  }
  const metadata: unknown = await response.json();
  if (!(object(metadata) && object(metadata.versions))) {
    throw new Error("Registry returned invalid core version metadata.");
  }
  if (!Object.keys(metadata.versions).some((version) => Bun.semver.satisfies(version, range))) {
    throw new Error(`Publish a compatible @teyik0/furin (${range}) before Electrobun.`);
  }
}

if (import.meta.main) {
  try {
    const [command, ...extra] = process.argv.slice(2);
    const eventPath = process.env.GITHUB_EVENT_PATH;
    const output = process.env.GITHUB_OUTPUT;
    if (
      (command !== "select" && command !== "verify") ||
      extra.length ||
      !eventPath ||
      (command === "select" && !output)
    ) {
      throw new Error(
        "Usage: release-target.ts select|verify with GITHUB_EVENT_PATH (and GITHUB_OUTPUT for select)."
      );
    }
    const root = process.env.GITHUB_WORKSPACE ?? resolve(import.meta.dir, "..");
    const target = await resolveReleaseTarget(await Bun.file(eventPath).json(), root);
    if (command === "verify") {
      await verifyReleasePrerequisites(
        target,
        root,
        process.env.NPM_REGISTRY_URL ?? "https://registry.npmjs.org"
      );
    } else if (output) {
      await appendFile(
        output,
        `directory=${target.directory}\ndist_tag=${target.distTag}\nname=${target.name}\nversion=${target.version}\n`
      );
    }
    console.log(`Release target: ${target.name}@${target.version} (${target.distTag})`);
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
}

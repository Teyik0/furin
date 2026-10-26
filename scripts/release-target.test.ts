import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveReleaseTarget, verifyReleasePrerequisites } from "./release-target";

test("an Electrobun GitHub release selects only its own stable manifest", async () => {
  const root = await mkdtemp(join(tmpdir(), "furin-release-"));
  try {
    await mkdir(join(root, "packages/electrobun"), { recursive: true });
    await writeFile(
      join(root, "packages/electrobun/package.json"),
      JSON.stringify({
        name: "@teyik0/furin-electrobun",
        version: "0.1.0",
      })
    );
    expect(
      await resolveReleaseTarget(
        {
          release: { tag_name: "electrobun-v0.1.0", prerelease: false },
        },
        root
      )
    ).toEqual({
      directory: "packages/electrobun",
      name: "@teyik0/furin-electrobun",
      version: "0.1.0",
      distTag: "latest",
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test.each([
  ["packages/core", "@teyik0/furin", "v", "0.7.0-alpha.5", true, "next"],
  ["apps/scaffolder", "create-furin", "create-furin-v", "0.4.1", false, "latest"],
  [
    "packages/electrobun",
    "@teyik0/furin-electrobun",
    "electrobun-v",
    "0.1.0+linux-x64",
    false,
    "latest",
  ],
] as const)(
  "release %s uses its independent version and channel",
  async (directory, name, prefix, version, prerelease, distTag) => {
    const root = await mkdtemp(join(tmpdir(), "furin-release-"));
    try {
      await mkdir(join(root, directory), { recursive: true });
      await writeFile(join(root, directory, "package.json"), JSON.stringify({ name, version }));
      expect(
        await resolveReleaseTarget(
          {
            release: { tag_name: `${prefix}${version}`, prerelease },
          },
          root
        )
      ).toEqual({ directory, name, version, distTag });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
);

test("release selection refuses unknown tags, invalid versions and mismatched manifests", async () => {
  const root = await mkdtemp(join(tmpdir(), "furin-release-errors-"));
  try {
    await mkdir(join(root, "packages/electrobun"), { recursive: true });
    await writeFile(
      join(root, "packages/electrobun/package.json"),
      JSON.stringify({
        name: "@teyik0/furin-electrobun",
        version: "0.1.0",
      })
    );
    for (const tag of [
      "tofu-v0.1.0",
      "electrobun-v0.2.0",
      "electrobun-v0.1",
      "electrobun-v00.1.0",
      "electrobun-v0.1.0-alpha.01",
    ]) {
      // biome-ignore lint/performance/noAwaitInLoops: Each rejection must finish before the next malformed event.
      await expect(
        resolveReleaseTarget({ release: { tag_name: tag, prerelease: false } }, root)
      ).rejects.toThrow();
    }
    await expect(
      resolveReleaseTarget({ release: { tag_name: "electrobun-v0.1.0", prerelease: true } }, root)
    ).rejects.toThrow("prerelease status");
    await expect(
      resolveReleaseTarget({ release: { tag_name: "v0.7.0-alpha.5", prerelease: false } }, root)
    ).rejects.toThrow("prerelease status");
    await expect(
      resolveReleaseTarget(
        { release: { tag_name: "electrobun-v0.1.0", prerelease: "false" } },
        root
      )
    ).rejects.toThrow("GitHub release event");
    await writeFile(
      join(root, "packages/electrobun/package.json"),
      JSON.stringify({
        name: "other-package",
        version: "0.1.0",
      })
    );
    await expect(
      resolveReleaseTarget({ release: { tag_name: "electrobun-v0.1.0", prerelease: false } }, root)
    ).rejects.toThrow("name and version");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the workflow CLI emits only the selected target and rejects before writing on invalid events", async () => {
  const root = await mkdtemp(join(tmpdir(), "furin-release-cli-"));
  try {
    await mkdir(join(root, "apps/scaffolder"), { recursive: true });
    await writeFile(
      join(root, "apps/scaffolder/package.json"),
      '{"name":"create-furin","version":"0.4.1"}'
    );
    const event = join(root, "event.json");
    const output = join(root, "output");
    await writeFile(event, '{"release":{"tag_name":"create-furin-v0.4.1","prerelease":false}}');
    const run = () =>
      Bun.spawnSync([process.execPath, join(import.meta.dir, "release-target.ts"), "select"], {
        env: {
          ...process.env,
          GITHUB_EVENT_PATH: event,
          GITHUB_OUTPUT: output,
          GITHUB_WORKSPACE: root,
        },
        stdout: "pipe",
        stderr: "pipe",
      });
    const valid = run();
    expect(valid.exitCode, valid.stderr.toString()).toBe(0);
    expect(await Bun.file(output).text()).toBe(
      "directory=apps/scaffolder\ndist_tag=latest\nname=create-furin\nversion=0.4.1\n"
    );
    await rm(output);
    await writeFile(event, '{"release":{"tag_name":"unknown-v1.0.0","prerelease":false}}');
    expect(run().exitCode).toBe(1);
    expect(await Bun.file(output).exists()).toBe(false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Electrobun publication requires an already published compatible core, not the repo core version", async () => {
  const root = await mkdtemp(join(tmpdir(), "furin-release-peer-"));
  let versions: { [version: string]: { version: string } } = {
    "0.7.0-alpha.3": { version: "0.7.0-alpha.3" },
  };
  let status = 200;
  const registry = Bun.serve({
    port: 0,
    fetch() {
      return Response.json({ versions }, { status });
    },
  });
  try {
    await mkdir(join(root, "packages/electrobun"), { recursive: true });
    await writeFile(
      join(root, "packages/electrobun/package.json"),
      JSON.stringify({
        name: "@teyik0/furin-electrobun",
        version: "0.1.0",
        peerDependencies: { "@teyik0/furin": ">=0.7.0-alpha.5 <0.8.0" },
      })
    );
    const target = await resolveReleaseTarget(
      { release: { tag_name: "electrobun-v0.1.0", prerelease: false } },
      root
    );
    await expect(verifyReleasePrerequisites(target, root, registry.url.href)).rejects.toThrow(
      "Publish a compatible @teyik0/furin"
    );
    versions = { "0.7.0-alpha.5": { version: "0.7.0-alpha.5" } };
    await verifyReleasePrerequisites(target, root, registry.url.href);
    // A later repo version does not force publishing core again for an unchanged peer contract.
    versions = { "0.7.1": { version: "0.7.1" } };
    await verifyReleasePrerequisites(target, root, registry.url.href);
    status = 503;
    await expect(verifyReleasePrerequisites(target, root, registry.url.href)).rejects.toThrow(
      "503"
    );
  } finally {
    await registry.stop(true);
    await rm(root, { recursive: true, force: true });
  }
});

test("CD publishes exactly the selected workspace with environment-only credentials", async () => {
  const workflow = Bun.YAML.parse(
    await Bun.file(join(import.meta.dir, "../.github/workflows/cd.yaml")).text()
  ) as {
    on: { release: { types: string[] } };
    jobs: {
      "publish-npm": {
        steps: {
          env?: { NPM_CONFIG_TOKEN?: string };
          run?: string;
          "working-directory"?: string;
        }[];
      };
    };
  };
  expect(workflow.on.release.types).toEqual(["published"]);
  const { steps } = workflow.jobs["publish-npm"];
  const publish = steps.filter((step) => step.run?.includes("bun publish"));
  expect(publish).toHaveLength(1);
  // biome-ignore lint/suspicious/noTemplateCurlyInString: Assert literal GitHub Actions expressions.
  expect(publish[0]?.["working-directory"]).toBe("${{ steps.release.outputs.directory }}");
  expect(publish[0]?.run).toBe(
    // biome-ignore lint/suspicious/noTemplateCurlyInString: Assert literal GitHub Actions expressions.
    'bun publish --access public --tag "${{ steps.release.outputs.dist_tag }}"'
  );
  // biome-ignore lint/suspicious/noTemplateCurlyInString: Assert literal GitHub Actions expressions.
  expect(publish[0]?.env?.NPM_CONFIG_TOKEN).toBe("${{ secrets.NPM_TOKEN }}");
  expect(steps.some((step) => step.run?.includes(".npmrc"))).toBe(false);
});

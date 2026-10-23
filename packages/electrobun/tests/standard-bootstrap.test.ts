import { expect, test } from "bun:test";
import { mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DesktopConfig } from "../src/config";
import { standardLaunchFixture, waitForFixture } from "./fixtures/standard-launch";

test("standard dev bootstrap loads SDK metadata before changing CWD and owns readiness without app plumbing", async () => {
  const fixture = await standardLaunchFixture({
    mode: "dev",
    dataDir: {
      name: "Example",
      developmentName: "Example-dev",
      env: "EXAMPLE_DATA_DIR",
    },
  });
  const host = fixture.launch({
    EXAMPLE_DATA_DIR: "state",
    FURIN_NATIVE_TEST_SCRIPT: "native-test.js",
  });
  try {
    const ready = await waitForFixture(
      async () => {
        if (host.child.exitCode !== null) {
          throw new Error((await host.output).join("\n"));
        }
        const file = Bun.file(join(fixture.generated, "ready.json"));
        return (await file.exists())
          ? ((await file.json()) as { origin: string; url: string })
          : undefined;
      },
      (value) => value !== undefined
    );
    if (!ready) {
      throw new Error("Missing readiness.");
    }
    const backend = (await Bun.file(join(fixture.root, "backend.json")).json()) as {
      dataDir: string;
      cwd: string;
    };
    const root = await realpath(fixture.root);
    expect(backend.dataDir).toBe(join(root, "state"));
    expect(await realpath(backend.cwd)).toBe(root);
    expect(await Bun.file(join(fixture.root, "opens")).text()).toContain("fixture://launch");
    expect((await fetch(ready.origin)).status).toBe(403);
    const bootstrap = await fetch(ready.url, { redirect: "manual" });
    const cookie = bootstrap.headers.get("set-cookie")?.split(";")[0] ?? "";
    const call = (path: string) => fetch(ready.origin + path, { headers: { cookie } });
    expect(((await (await call("/")).json()) as { dataDir: string }).dataDir).toBe(backend.dataDir);
    await waitForFixture(() => Bun.file(join(fixture.root, "test-scripts")).exists(), Boolean);
    expect(await Bun.file(join(fixture.root, "test-scripts")).text()).toBe(
      `${JSON.stringify(fixture.script)}\n`
    );
    await call("/background");
    await waitForFixture(() => Bun.file(join(fixture.root, "window-closed")).exists(), Boolean);
    await call("/open");
    await waitForFixture(
      () => Bun.file(join(fixture.root, "test-scripts")).text(),
      (value) => value.split("\n").length === 3
    );
    expect(await host.stop("SIGTERM"), (await host.output).join("\n")).toBe(0);
    expect(await Bun.file(join(fixture.root, "lifecycle")).text()).toBe("start\nstop\n");
    expect(await Bun.file(join(fixture.generated, "failure.json")).exists()).toBe(false);
  } finally {
    await host.stop("SIGTERM");
    await fixture.close();
  }
}, 20_000);

test.each([
  "default",
  "default-dev",
  "legacy",
  "override",
  "relative",
  "absolute",
  "packaged-dev",
] as const)(
  "packaged standard storage preserves %s paths for the launching user",
  async (policy) => {
    const absolute = join(tmpdir(), `furin-absolute-${crypto.randomUUID()}`);
    let dataDir: DesktopConfig["dataDir"];
    const defaultPolicy = policy === "default" || policy === "default-dev";
    if (!defaultPolicy) {
      dataDir = { name: "Example", developmentName: "Example-dev", env: "EXAMPLE_DATA_DIR" };
    }
    if (policy === "absolute") {
      dataDir = absolute;
    }
    const fixture = await standardLaunchFixture({
      mode: "build",
      channel: policy === "packaged-dev" || policy === "default-dev" ? "dev" : "stable",
      dataDir,
    });
    const overridden = join(fixture.launchHome, "chosen-state");
    // The default keeps development data out of the release directory.
    let expected = join(
      fixture.launchHome,
      "sdk-data",
      policy === "default-dev" ? "local.furin.launch.dev" : "local.furin.launch"
    );
    if (!defaultPolicy) {
      const base =
        process.platform === "win32"
          ? join(fixture.launchHome, "AppData/Roaming")
          : join(
              fixture.launchHome,
              process.platform === "darwin" ? "Library/Application Support" : ".local/share"
            );
      expected = join(base, policy === "packaged-dev" ? "Example-dev" : "Example");
    }
    let override: string | undefined;
    if (policy === "override") {
      override = overridden;
      expected = overridden;
    }
    if (policy === "relative") {
      override = "relative-state";
      expected = join(await realpath(fixture.cwd), override);
    }
    if (policy === "absolute") {
      expected = absolute;
    }
    await mkdir(expected, { recursive: true });
    await writeFile(join(expected, "existing-data"), "preserved");
    const host = fixture.launch({
      EXAMPLE_DATA_DIR: override,
    });
    try {
      await waitForFixture(async () => {
        if (host.child.exitCode !== null) {
          throw new Error((await host.output).join("\n"));
        }
        return Bun.file(join(fixture.root, "window-url")).exists();
      }, Boolean);
      const backend = (await Bun.file(join(fixture.root, "backend.json")).json()) as {
        dataDir: string;
        cwd: string;
        origin: string;
      };
      expect(backend.dataDir).toBe(expected);
      expect(await Bun.file(join(expected, "existing-data")).text()).toBe("preserved");
      expect(await realpath(backend.cwd)).toBe(await realpath(fixture.cwd));
      expect(await Bun.file(join(expected, ".furin-native/descriptor.json")).exists()).toBe(true);
      const serialized = await Bun.file(join(fixture.generated, "host.json")).text();
      expect(serialized).not.toContain(fixture.buildHome);
      expect(backend.dataDir).not.toContain(fixture.buildHome);
      expect(await Bun.file(join(fixture.root, "test-scripts")).exists()).toBe(false);
      const secondary = fixture.launch({
        EXAMPLE_DATA_DIR: override,
      });
      try {
        expect(
          await Promise.race([secondary.child.exited, Bun.sleep(6500).then(() => undefined)]),
          (await secondary.output).join("\n")
        ).toBe(0);
        await waitForFixture(
          () => Bun.file(join(fixture.root, "opens")).text(),
          (value) => value.split("\n").length === 3
        );
        expect(await Bun.file(join(fixture.root, "lifecycle")).text()).toBe("start\n");
        const bootstrap = await fetch(await Bun.file(join(fixture.root, "window-url")).text(), {
          redirect: "manual",
        });
        const cookie = bootstrap.headers.get("set-cookie")?.split(";")[0] ?? "";
        expect((await fetch(backend.origin, { headers: { cookie } })).status).toBe(200);
      } finally {
        await secondary.stop("SIGTERM");
      }
      expect(await host.stop("SIGTERM")).toBe(0);
      expect(await Bun.file(join(fixture.root, "lifecycle")).text()).toBe("start\nstop\n");
      expect(await Bun.file(join(expected, ".furin-native/descriptor.json")).exists()).toBe(false);
    } finally {
      await host.stop("SIGTERM");
      await fixture.close();
      if (policy === "absolute") {
        await rm(absolute, { recursive: true, force: true });
      }
    }
  },
  20_000
);

test.each(["SIGINT", "SIGTERM"] as const)(
  "packaged %s cleanup is idempotent and does not terminate with a signal",
  async (signal) => {
    const fixture = await standardLaunchFixture({ mode: "build" });
    const host = fixture.launch();
    try {
      await waitForFixture(() => Bun.file(join(fixture.root, "window-url")).exists(), Boolean);
      if (process.platform === "win32") {
        host.child.send(signal);
      } else {
        host.child.kill(signal);
      }
      host.child.send(signal);
      expect(
        await Promise.race([host.child.exited, Bun.sleep(6500).then(() => undefined)]),
        (await host.output).join("\n")
      ).toBe(0);
      expect(host.child.signalCode).toBeNull();
      expect(await Bun.file(join(fixture.root, "lifecycle")).text()).toBe("start\nstop\n");
      expect(await Bun.file(join(fixture.root, "quit")).text()).toBe("0");
    } finally {
      await host.stop("SIGTERM");
      await fixture.close();
    }
  },
  15_000
);

test("standard development reports cleanup failure without application readiness glue", async () => {
  const fixture = await standardLaunchFixture({
    mode: "dev",
    failure: 'throw new Error("fixture cleanup failed");',
  });
  const host = fixture.launch();
  try {
    await waitForFixture(() => Bun.file(join(fixture.generated, "ready.json")).exists(), Boolean);
    expect(await host.stop("SIGTERM")).toBe(1);
    expect(await Bun.file(join(fixture.generated, "failure.json")).json()).toEqual({
      kind: "shutdown-failure",
    });
    expect(await Bun.file(join(fixture.root, "lifecycle")).text()).toBe("start\nstop\n");
  } finally {
    await host.stop("SIGTERM");
    await fixture.close();
  }
}, 15_000);

test.each([false, true])(
  "packaged cancellation during startup preserves cleanup failure=%s",
  async (failure) => {
    const fixture = await standardLaunchFixture({
      mode: "build",
      startup: "return new Promise(() => {});",
      failure: failure ? 'throw new Error("fixture cleanup failed");' : undefined,
    });
    const host = fixture.launch();
    try {
      await waitForFixture(() => Bun.file(join(fixture.root, "lifecycle")).exists(), Boolean);
      expect(await host.stop("SIGTERM"), (await host.output).join("\n")).toBe(failure ? 1 : 0);
      expect(await Bun.file(join(fixture.root, "lifecycle")).text()).toBe("start\nstop\n");
      expect(await Bun.file(join(fixture.root, "window-url")).exists()).toBe(false);
    } finally {
      await host.stop("SIGTERM");
      await fixture.close();
    }
  },
  15_000
);

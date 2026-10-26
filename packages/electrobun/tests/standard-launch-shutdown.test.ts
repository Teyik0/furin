import { expect, test } from "bun:test";
import { join } from "node:path";
import { standardLaunchFixture, waitForFixture } from "./fixtures/standard-launch";

test("fixture shutdown waits for a failing child after IPC closes before process exit", async () => {
  const fixture = await standardLaunchFixture({
    mode: "build",
    startup: `while (!(await Bun.file(process.env.FURIN_FIXTURE_RELEASE).exists())) { await Bun.sleep(10); }
      throw new Error("fixture original startup failure");`,
  });
  const release = join(fixture.root, "release");
  const host = fixture.launch({ FURIN_FIXTURE_RELEASE: release });
  try {
    await waitForFixture(() => Bun.file(join(fixture.root, "lifecycle")).exists(), Boolean);
    expect(host.child.exitCode).toBeNull();
    expect(host.child.signalCode).toBeNull();
    host.child.disconnect();
    await Bun.write(release, "release");
    expect(await host.stop("SIGTERM")).toBe(1);
    expect((await host.output).join("\n")).toContain("fixture original startup failure");
    expect(await Bun.file(join(fixture.root, "lifecycle")).text()).toBe("start\nstop\n");
    expect(await Bun.file(join(fixture.root, "window-url")).exists()).toBe(false);
    expect(await host.stop("SIGTERM")).toBe(1);
  } finally {
    if (host.child.exitCode === null && host.child.signalCode === null) {
      host.child.kill("SIGKILL");
    }
    await host.child.exited;
    await fixture.close();
  }
}, 15_000);

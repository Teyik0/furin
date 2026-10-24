import { expect, test } from "bun:test";
import { join } from "node:path";
import { standardLaunchFixture, waitForFixture } from "./fixtures/standard-launch";

// Scheduling a task is an OS mutation: Windows native handoff is explicitly opt-in.
test
  .skipIf(process.platform === "win32" && process.env.FURIN_NATIVE_RESTART_TEST !== "1")
  .each(["reported", "throw", "cancelled"] as const)(
  "failed update %s starts a fresh native process after both locks and old launcher exit",
  async (handoff) => {
    const fixture = await standardLaunchFixture({
      mode: "build",
      handoff,
      nativeLauncher: true,
      applicationLease: true,
    });
    const old = fixture.launch();
    let replacement: { origin: string; cookie: string; pid: number; dataDir: string } | undefined;
    try {
      const sessions = new Map<
        number,
        { origin: string; pid: number; dataDir: string; cookie: string }
      >();
      const consumedWindows = new Set<string>();
      const read = async () => {
        const file = Bun.file(join(fixture.root, "backend.json"));
        if (!(await file.exists())) {
          return;
        }
        const value = (await file.json()) as { origin: string; pid: number; dataDir: string };
        const cached = sessions.get(value.pid);
        if (cached) {
          return cached;
        }
        const windowUrl = Bun.file(join(fixture.root, "window-url"));
        if (!(await windowUrl.exists())) {
          return;
        }
        const url = await windowUrl.text();
        if (consumedWindows.has(url)) {
          return;
        }
        const bootstrap = await fetch(url, { redirect: "manual" });
        const location = bootstrap.headers.get("location");
        const cookie = bootstrap.headers.get("set-cookie")?.split(";")[0];
        if (!(location && cookie) || new URL(location).origin !== value.origin) {
          return;
        }
        const session = { ...value, cookie };
        consumedWindows.add(url);
        sessions.set(value.pid, session);
        return session;
      };
      const first = await waitForFixture(read, (value) => value !== undefined);
      if (!first) {
        throw new Error("Initial native host did not start.");
      }
      await waitForFixture(() => Bun.file(join(fixture.root, "window-url")).exists(), Boolean);
      const request = fetch(`${first.origin}/update`, { headers: { cookie: first.cookie } })
        .then((response) => response.arrayBuffer())
        .catch(() => undefined);
      replacement = await waitForFixture(read, (value) => !!value && value.pid !== first.pid);
      if (!replacement) {
        throw new Error("Native relaunch did not become ready.");
      }
      await request;
      expect(await old.child.exited, (await old.output).join("\n")).toBe(0);
      expect(replacement.pid).not.toBe(first.pid);
      expect(replacement.dataDir).toBe(first.dataDir);
      expect(() => process.kill(first.pid, 0)).toThrow();
      const events = (await Bun.file(join(fixture.root, "launcher-events")).text())
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { type: string; pid: number });
      expect(events.slice(0, 3).map((event) => event.type)).toEqual(["start", "exit", "start"]);
      expect(events[0]?.pid).toBe(old.child.pid);
      expect(events[2]?.pid).not.toBe(old.child.pid);
      expect(await Bun.file(join(fixture.root, "lifecycle")).text()).toBe("start\nstop\nstart\n");
      expect(await Bun.file(join(fixture.root, "error-dialog")).json()).toMatchObject({
        type: "error",
        title: "Update failed",
      });
      expect((await fetch(replacement.origin)).status).toBe(403);
      expect(
        (await fetch(replacement.origin, { headers: { cookie: replacement.cookie } })).status
      ).toBe(200);
      await fetch(`${replacement.origin}/quit`, { headers: { cookie: replacement.cookie } }).catch(
        () => undefined
      );
      await waitForFixture(
        () => Bun.file(join(fixture.root, "lifecycle")).text(),
        (value) => value === "start\nstop\nstart\nstop\n"
      );
    } finally {
      if (replacement) {
        await fetch(`${replacement.origin}/quit`, {
          headers: { cookie: replacement.cookie },
        }).catch(() => undefined);
      }
      await old.stop("SIGTERM");
      await fixture.close();
    }
  },
  20_000
);

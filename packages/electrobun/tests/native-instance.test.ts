import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { OpenEvent } from "../src/capabilities";
import { forwardNativeOpen, openNativeInstance } from "../src/native-instance";

test("native handoff is isolated, authenticated and limited to registered open events", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "furin-native-instance-"));
  const identity = {
    identifier: "local.furin.events",
    channel: "dev",
    version: "1.0.0",
    name: "Events",
  };
  const received: OpenEvent[] = [];
  let activated = false;
  const options = {
    dataDir,
    identity,
    schemes: ["fixture"],
    extensions: ["torrent"],
    onOpen: (event: OpenEvent) => {
      received.push(event);
    },
    onActivate: () => {
      activated = true;
    },
  };
  let primary: Awaited<ReturnType<typeof openNativeInstance>>;
  try {
    primary = await openNativeInstance(options);
    expect(primary).toBeDefined();
    expect(await openNativeInstance(options)).toBeUndefined();
    const descriptor: { origin: string } = await Bun.file(
      join(dataDir, ".furin-native/descriptor.json")
    ).json();
    expect((await fetch(`${descriptor.origin}/open`, { method: "POST", body: "{}" })).status).toBe(
      403
    );
    expect(
      await forwardNativeOpen(dataDir, identity, { type: "url", url: "fixture://oauth#private" })
    ).toBe(true);
    expect(received).toEqual([{ type: "url", url: "fixture://oauth#private" }]);
    await expect(
      forwardNativeOpen(dataDir, identity, { type: "url", url: "other://oauth" })
    ).rejects.toThrow();
    await expect(forwardNativeOpen(dataDir, { ...identity, channel: "stable" })).rejects.toThrow();
    expect(await forwardNativeOpen(dataDir, identity)).toBe(true);
    expect(activated).toBe(true);
    const path = join(dataDir, "A file.torrent");
    for (const input of [path, pathToFileURL(path).href]) {
      const child = Bun.spawn(
        [
          process.execPath,
          join(import.meta.dir, "../src/native-open.ts"),
          dataDir,
          identity.identifier,
          identity.channel,
          input,
        ],
        { stdout: "pipe", stderr: "pipe", timeout: 5000, killSignal: "SIGKILL" }
      );
      // biome-ignore lint/performance/noAwaitInLoops: Observe each helper delivery before checking its event.
      const [code, diagnostic] = await Promise.all([
        child.exited,
        new Response(child.stderr).text(),
      ]);
      expect(code, diagnostic).toBe(0);
      expect(received.at(-1)).toEqual({ type: "file", path });
    }
    await primary?.stop();
    primary = undefined;
    expect(await forwardNativeOpen(dataDir, identity)).toBe(false);
  } finally {
    await primary?.stop();
    await rm(dataDir, { recursive: true, force: true });
  }
});

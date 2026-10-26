import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { OpenEvent } from "../src/capabilities";
import {
  deliverToNativeOwner,
  forwardNativeOpen,
  openNativeInstance,
} from "../src/native-instance";

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

test("a secondary launch waits for the owner to publish its descriptor", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "furin-native-race-"));
  const identity = {
    identifier: "local.furin.race",
    channel: "dev",
    version: "1.0.0",
    name: "Race",
  };
  const received: OpenEvent[] = [];
  let primary: Awaited<ReturnType<typeof openNativeInstance>>;
  try {
    // The secondary starts forwarding before the owner has published anything.
    const delivered = deliverToNativeOwner(dataDir, identity, {
      type: "url",
      url: "fixture://late",
    });
    await Bun.sleep(100);
    primary = await openNativeInstance({
      dataDir,
      identity,
      schemes: ["fixture"],
      extensions: [],
      onOpen: (event) => {
        received.push(event);
      },
      onActivate: () => undefined,
    });
    expect(await delivered).toBe(true);
    expect(received).toEqual([{ type: "url", url: "fixture://late" }]);
  } finally {
    await primary?.stop();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test.skipIf(process.platform !== "win32")(
  "native instance creation sets the user owner and a protected private Windows ACL",
  async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "furin-native-acl-"));
    let instance: Awaited<ReturnType<typeof openNativeInstance>>;
    try {
      instance = await openNativeInstance({
        dataDir,
        identity: { name: "ACL", identifier: "local.furin.acl", version: "1.0.0", channel: "dev" },
        schemes: [],
        extensions: [],
        onOpen: () => undefined,
        onActivate: () => undefined,
      });
      expect(instance).toBeDefined();
      const query = Bun.spawn(
        [
          "powershell.exe",
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          `
      $ErrorActionPreference = 'Stop'
      $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User
      $acl = Get-Acl -LiteralPath $env:FURIN_NATIVE_DIRECTORY
      $rules = $acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])
      @{
        owned = $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -eq $sid.Value
        protected = $acl.AreAccessRulesProtected
        private = @($rules | Where-Object { $_.IdentityReference.Value -ne $sid.Value }).Count -eq 0
        fullControl = @($rules | Where-Object { $_.FileSystemRights -eq 'FullControl' -and $_.AccessControlType -eq 'Allow' }).Count -eq 1
      } | ConvertTo-Json -Compress
    `,
        ],
        {
          env: { ...process.env, FURIN_NATIVE_DIRECTORY: join(dataDir, ".furin-native") },
          stdout: "pipe",
          stderr: "pipe",
          timeout: 5000,
        }
      );
      const [code, result, diagnostic] = await Promise.all([
        query.exited,
        new Response(query.stdout).text(),
        new Response(query.stderr).text(),
      ]);
      expect(code, diagnostic).toBe(0);
      expect(JSON.parse(result)).toEqual({
        owned: true,
        protected: true,
        private: true,
        fullControl: true,
      });
    } finally {
      await instance?.stop();
      await rm(dataDir, { recursive: true, force: true });
    }
  }
);

test("native instance refuses a linked private directory without publishing a descriptor", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "furin-native-link-"));
  try {
    const target = join(dataDir, "target");
    await mkdir(target);
    await symlink(target, join(dataDir, ".furin-native"), "junction");
    await expect(
      openNativeInstance({
        dataDir,
        identity: {
          name: "Link",
          identifier: "local.furin.link",
          version: "1.0.0",
          channel: "dev",
        },
        schemes: [],
        extensions: [],
        onOpen: () => undefined,
        onActivate: () => undefined,
      })
    ).rejects.toThrow("link");
    expect(await Bun.file(join(target, "descriptor.json")).exists()).toBe(false);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

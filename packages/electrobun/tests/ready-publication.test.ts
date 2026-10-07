import { expect, test } from "bun:test";
import { link, mkdir, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { publishDevReady } from "../src/dev-server";

const ready = {
  origin: "http://localhost:1234",
  bootstrapOrigin: "http://localhost:1235",
  url: "http://localhost:1235/bootstrap?token=secret",
};

test("ready publication replaces the old inode with complete owner-only JSON", async () => {
  const root = await mkdtemp(join(tmpdir(), "furin-ready-"));
  try {
    const path = join(root, "ready.json");
    await writeFile(path, "previous", { mode: 0o644 });
    await link(path, join(root, "previous"));
    await publishDevReady(path, ready);
    expect(await Bun.file(path).json()).toEqual(ready);
    expect(await Bun.file(join(root, "previous")).text()).toBe("previous");
    // biome-ignore lint/suspicious/noBitwiseOperators: Read owner-only credential permission bits.
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect((await readdir(root)).sort()).toEqual(["previous", "ready.json"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("ready publication removes its temporary credential file when rename fails", async () => {
  const root = await mkdtemp(join(tmpdir(), "furin-ready-fail-"));
  try {
    const path = join(root, "ready.json");
    await mkdir(path);
    await expect(publishDevReady(path, ready)).rejects.toThrow();
    expect(await readdir(root)).toEqual(["ready.json"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

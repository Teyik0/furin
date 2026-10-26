import { expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { nativeLaunchEvents } from "../src/open-events";

test("launch arguments preserve registered URI fragments and normalize file inputs without reading them", () => {
  const directory = tmpdir();
  const events = nativeLaunchEvents(
    [
      "--env=dev",
      "index.js",
      "tofu://oauth#access_token=example",
      "https://example.com",
      "A file.torrent",
      pathToFileURL(resolve(directory, "Another file.torrent")).href,
    ],
    ["tofu"],
    ["torrent"],
    directory
  );
  expect(events).toEqual([
    { type: "url", url: "tofu://oauth#access_token=example" },
    { type: "file", path: resolve(directory, "A file.torrent") },
    { type: "file", path: resolve(directory, "Another file.torrent") },
  ]);
});

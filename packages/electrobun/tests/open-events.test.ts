import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { nativeLaunchEvents } from "../src/open-events";

test("launch arguments preserve registered URI fragments and normalize file inputs without reading them", () => {
  const events = nativeLaunchEvents(
    [
      "--env=dev",
      "index.js",
      "tofu://oauth#access_token=example",
      "https://example.com",
      "A file.torrent",
      "file:///tmp/Another%20file.torrent",
    ],
    ["tofu"],
    ["torrent"],
    "/tmp"
  );
  expect(events).toEqual([
    { type: "url", url: "tofu://oauth#access_token=example" },
    { type: "file", path: resolve("/tmp", "A file.torrent") },
    { type: "file", path: resolve("/tmp", "Another file.torrent") },
  ]);
});

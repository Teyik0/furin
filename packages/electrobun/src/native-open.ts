import { dirname, extname, isAbsolute, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { OpenEvent } from "./capabilities";
import { forwardNativeOpen } from "./native-instance";

if (import.meta.main) {
  try {
    const [dataDir, identifier, channel, input, ...extra] = Bun.argv.slice(2);
    if (!(dataDir && identifier && channel && input) || extra.length) {
      throw new Error("Invalid native invocation.");
    }
    let event: OpenEvent;
    if (isAbsolute(input)) {
      // A Windows drive prefix is also parseable as a URL scheme.
      event = { type: "file", path: resolve(input) };
    } else if (URL.canParse(input)) {
      const url = new URL(input);
      event =
        url.protocol === "file:"
          ? { type: "file", path: fileURLToPath(url) }
          : { type: "url", url: url.href };
    } else if (extname(input)) {
      event = { type: "file", path: resolve(input) };
    } else {
      throw new Error("Invalid native input.");
    }
    if (!(await forwardNativeOpen(dataDir, { identifier, channel }, event))) {
      const executable = process.platform === "darwin" ? "MacOS/launcher" : "bin/launcher";
      const launcher = resolve(
        dirname(Bun.main),
        "../../..",
        process.platform === "win32" ? `${executable}.exe` : executable
      );
      if (!(await Bun.file(launcher).exists())) {
        throw new Error("The native launcher is unavailable.");
      }
      const url = event.type === "url" ? event.url : pathToFileURL(event.path).href;
      const child = Bun.spawn([launcher], {
        env: { ...process.env, FURIN_NATIVE_OPEN: url },
        detached: true,
        stdin: "ignore",
        stdout: "ignore",
        stderr: "ignore",
      });
      child.unref();
    }
  } catch {
    // Native URLs can contain OAuth fragments; never print invocation or URL data.
    console.error("[furin-electrobun] Unable to deliver the native open event.");
    process.exitCode = 1;
  }
}

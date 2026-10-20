import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createContext } from "../src/pipeline/context";
import { stage7Refinement } from "../src/pipeline/stages/7-refinement";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { force: true, recursive: true });
  }
});

describe("stage7Refinement", () => {
  it("keeps the event loop running while dependencies install", async () => {
    const targetDir = mkdtempSync(resolve(tmpdir(), "create-furin-refinement-"));
    tempDirs.push(targetDir);
    writeFileSync(
      resolve(targetDir, "package.json"),
      JSON.stringify({
        name: "slow-install",
        private: true,
        scripts: { postinstall: 'bun -e "await Bun.sleep(300)"' },
      })
    );

    // The install spinner animates on a timer, so timers must fire during install.
    let ticks = 0;
    const interval = setInterval(() => {
      ticks += 1;
    }, 10);
    try {
      await stage7Refinement(createContext({ install: true, targetDir }));
    } finally {
      clearInterval(interval);
    }

    expect(ticks).toBeGreaterThan(0);
  }, 15_000);
});

import { Link } from "@teyik0/furin/link";
import type { CSSProperties } from "react";
import { Reveal } from "./reveal";

// Output shortened from a real `--compile embed` run on examples/task-manager
// (Bun 1.4.2, macOS arm64): a 70,020,594-byte executable.
const LINES = [
  { kind: "cmd", text: "furin build --target bun --compile embed" },
  { kind: "out", text: "[furin] Production client build complete" },
  { kind: "out", text: "[furin] Server binary: .furin/build/bun/server" },
  { kind: "cmd", text: "ls -lh .furin/build/bun/server" },
  { kind: "out", text: "-rwxr-xr-x  67M  server" },
  { kind: "cmd", text: "./server" },
  { kind: "out", text: "Furin app running at http://localhost:3000" },
] as const;

/** Compact "ship one binary" strip: the compile command, the artifact, and running it. */
export function ShipSection() {
  return (
    <section className="lp-defer relative py-24 sm:py-32">
      <div className="mx-auto grid max-w-7xl items-center gap-12 px-5 sm:px-8 lg:grid-cols-[0.9fr_1.1fr]">
        <Reveal>
          <p className="lp-eyebrow mb-5">05 — Ship</p>
          <h2 className="lp-h2 mb-6">
            One file.
            <br />
            <span className="text-muted-foreground">Zero node_modules.</span>
          </h2>
          <p className="max-w-md text-muted-foreground leading-relaxed sm:text-lg">
            <code className="lp-code">--compile embed</code> bundles Bun, Elysia, React, your pages
            and every client asset into a single executable. Copy it to a server and run it.
          </p>
          <p className="mt-6 text-sm">
            <Link className="lp-link" to="/docs/deployment">
              Deployment options →
            </Link>
          </p>
        </Reveal>
        <Reveal className="ship-term min-w-0" delay={120}>
          <div className="code-glass overflow-hidden rounded-2xl">
            <div className="flex items-center gap-2 border-white/[0.07] border-b px-4 py-2.5">
              <span className="size-2 rounded-full bg-white/15" />
              <span className="size-2 rounded-full bg-white/15" />
              <span className="size-2 rounded-full bg-white/15" />
              <span className="ml-2 font-mono text-[12px] text-zinc-400">zsh — task-manager</span>
            </div>
            <pre className="overflow-x-auto p-5 font-mono text-[12.5px] leading-[1.9]">
              {LINES.map((line, i) => (
                <span
                  className={`ship-line block ship-line--${line.kind}`}
                  key={line.text}
                  style={{ "--i": i } as CSSProperties}
                >
                  {line.kind === "cmd" && <span className="text-[var(--lp-accent)]">$ </span>}
                  {line.text}
                </span>
              ))}
            </pre>
          </div>
          <p className="mt-3 font-mono text-[11px] text-muted-foreground">
            67 MB · task-manager example · Bun 1.4.2, macOS arm64
          </p>
        </Reveal>
      </div>
    </section>
  );
}

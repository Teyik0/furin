import { Check, Copy } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { cn } from "@/lib/utils";

const COMMAND = "bun create furin@latest";

export function CopyCommand({ className }: { className?: string }) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) {
      return;
    }
    const id = window.setTimeout(() => setCopied(false), 1600);
    return () => window.clearTimeout(id);
  }, [copied]);

  const copy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(COMMAND);
      setCopied(true);
    } catch {
      // Clipboard blocked (insecure context / permissions): the command stays selectable.
    }
  }, []);

  return (
    <button
      aria-label={copied ? "Copied to clipboard" : `Copy command: ${COMMAND}`}
      className={cn(
        "group glass-pill inline-flex h-12 items-center gap-3 rounded-full pr-2 pl-5 font-mono text-[13px] text-foreground/85 transition-colors hover:text-foreground focus-visible:outline-2 focus-visible:outline-[var(--lp-accent)] focus-visible:outline-offset-2",
        className
      )}
      onClick={copy}
      type="button"
    >
      <span className="select-all">
        <span className="text-[var(--lp-accent)]">$</span> {COMMAND}
      </span>
      <span className="inline-flex size-8 items-center justify-center rounded-full bg-foreground/[0.06] text-foreground/60 transition-colors group-hover:bg-foreground/10 group-hover:text-foreground">
        {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
      </span>
      <span aria-live="polite" className="sr-only">
        {copied ? "Copied" : ""}
      </span>
    </button>
  );
}

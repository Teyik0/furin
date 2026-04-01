"use client";

import { Check, ChevronDown, Copy, ExternalLink } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRoot,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { DocNavItem } from "@/lib/docs";
import { buildOpenInUrl } from "@/lib/docs";

interface DocsActionsProps {
  doc: DocNavItem;
  markdownSource: string;
}

const OPEN_IN_LABELS = {
  github: "GitHub",
  chatgpt: "ChatGPT",
  claude: "Claude",
  cursor: "Cursor",
  copilot: "Copilot",
} as const;

export function DocsActions({ doc, markdownSource }: DocsActionsProps) {
  const [copyState, setCopyState] = useState<"idle" | "copied" | "error">("idle");
  let copyLabel = "Copy MD";
  if (copyState === "copied") {
    copyLabel = "Copied";
  } else if (copyState === "error") {
    copyLabel = "Retry Copy";
  }

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(markdownSource);
      setCopyState("copied");
      window.setTimeout(() => setCopyState("idle"), 1800);
    } catch {
      setCopyState("error");
      window.setTimeout(() => setCopyState("idle"), 1800);
    }
  }

  const openTargets = doc.openIn
    .map((target) => ({
      target,
      url: buildOpenInUrl(target, doc, markdownSource),
    }))
    .filter((entry): entry is { target: (typeof doc.openIn)[number]; url: string } =>
      Boolean(entry.url)
    );

  return (
    <div className="not-prose mb-8 flex flex-wrap items-center gap-3 border-border border-b pb-5">
      <Button className="gap-2" onClick={handleCopy} size="sm" type="button" variant="outline">
        {copyState === "copied" ? <Check className="size-4" /> : <Copy className="size-4" />}
        {copyLabel}
      </Button>

      <DropdownMenuRoot>
        <DropdownMenuTrigger asChild>
          <Button className="gap-2" size="sm" type="button" variant="outline">
            Open in
            <ChevronDown className="size-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-64">
          <DropdownMenuLabel>Open this page elsewhere</DropdownMenuLabel>
          <DropdownMenuSeparator />
          {openTargets.map(({ target, url }) => (
            <DropdownMenuItem asChild key={target}>
              <a
                className="flex items-center justify-between"
                href={url}
                rel="noopener noreferrer"
                target="_blank"
              >
                <span>{OPEN_IN_LABELS[target]}</span>
                <ExternalLink className="size-4 text-muted-foreground" />
              </a>
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenuRoot>
    </div>
  );
}

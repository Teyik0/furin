import { RouterContext } from "@teyik0/furin/link";
import { ArrowUpRight, Check, ChevronDown, Copy, FileText } from "lucide-react";
import { use, useState } from "react";
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
  chatgpt: "ChatGPT",
  claude: "Claude",
  copilot: "Copilot",
  cursor: "Cursor",
  github: "GitHub",
} as const;

export function DocsActions({ doc, markdownSource }: DocsActionsProps) {
  const router = use(RouterContext);
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

  const openTargets: { target: (typeof doc.openIn)[number]; url: string }[] = [];
  for (const target of doc.openIn) {
    const url = buildOpenInUrl(target, doc, markdownSource);
    if (url) {
      openTargets.push({ target, url });
    }
  }

  return (
    <fieldset aria-label="Page actions" className="docs-actions not-prose">
      <Button asChild className="docs-action" size="sm" variant="ghost">
        <a href={`${router?.basePath ?? ""}${doc.href}.md`}>
          <FileText data-icon="inline-start" />
          Markdown
        </a>
      </Button>
      <Button
        className="docs-action docs-action-copy"
        onClick={handleCopy}
        size="sm"
        type="button"
        variant="ghost"
      >
        {copyState === "copied" ? (
          <Check data-icon="inline-start" />
        ) : (
          <Copy data-icon="inline-start" />
        )}
        <span aria-live="polite">{copyLabel}</span>
      </Button>

      <DropdownMenuRoot>
        <DropdownMenuTrigger asChild>
          <Button className="docs-action" size="sm" type="button" variant="ghost">
            Open in
            <ChevronDown data-icon="inline-end" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="docs-actions-menu" sideOffset={6}>
          <DropdownMenuLabel className="docs-actions-menu-label">Open page in</DropdownMenuLabel>
          <DropdownMenuSeparator />
          {openTargets.map(({ target, url }) => (
            <DropdownMenuItem asChild className="docs-actions-menu-item" key={target}>
              <a href={url} rel="noopener noreferrer" target="_blank">
                <span>{OPEN_IN_LABELS[target]}</span>
                <ArrowUpRight aria-hidden="true" />
              </a>
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenuRoot>
    </fieldset>
  );
}

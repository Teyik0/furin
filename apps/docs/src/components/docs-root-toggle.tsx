import { Link } from "@teyik0/furin/link";
import type { LucideIcon } from "lucide-react";
import { BookOpen, Check, ChevronsUpDown, MonitorSmartphone } from "lucide-react";
import {
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRoot,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { DOCS_AREAS } from "@/lib/docs";

const AREA_ICONS: { [title: string]: LucideIcon } = {
  [DOCS_AREAS[0].title]: BookOpen,
  [DOCS_AREAS[1].title]: MonitorSmartphone,
};

/**
 * Sidebar root toggle, following fumadocs' documentation-area selector.
 * The active area is derived from the current pathname; picking another
 * area navigates to its landing page and the sidebar switches sections.
 */
export function DocsRootToggle({ pathname }: { pathname: string }) {
  const activeIndex = DOCS_AREAS.findIndex((area) =>
    area.title === DOCS_AREAS[1].title
      ? pathname.startsWith("/docs/desktop")
      : !pathname.startsWith("/docs/desktop")
  );
  const active = DOCS_AREAS[activeIndex] ?? DOCS_AREAS[0];

  return (
    <DropdownMenuRoot>
      <DropdownMenuTrigger asChild>
        <button
          aria-label="Switch documentation area"
          className="flex w-full items-center gap-2 rounded-lg border px-3 py-2 text-left text-sm transition-colors hover:bg-muted"
          type="button"
        >
          <span className="truncate font-medium">{active.title}</span>
          <ChevronsUpDown aria-hidden="true" className="ml-auto size-4 text-muted-foreground" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-72">
        {DOCS_AREAS.map((area) => {
          const Icon = AREA_ICONS[area.title] ?? BookOpen;
          return (
            <DropdownMenuItem asChild key={area.href}>
              <Link className="flex items-start gap-3" to={area.href}>
                <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-md border bg-muted/60 [&_svg]:size-4">
                  <Icon aria-hidden="true" />
                </span>
                <span className="flex flex-col gap-0.5">
                  <span className="flex items-center gap-1.5 font-medium text-[13.5px]">
                    {area.title}
                    {area.title === active.title && (
                      <Check aria-hidden="true" className="size-3.5 text-muted-foreground" />
                    )}
                  </span>
                  <span className="text-muted-foreground text-xs leading-snug">
                    {area.description}
                  </span>
                </span>
              </Link>
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenuRoot>
  );
}

import { Link } from "@teyik0/furin/link";
import { getDocNeighbors } from "@/lib/docs";

interface DocsPagerProps {
  pathname: string;
}

export function DocsPager({ pathname }: DocsPagerProps) {
  const { next, prev } = getDocNeighbors(pathname);

  if (!(prev || next)) {
    return null;
  }

  return (
    <nav aria-label="Adjacent documentation pages" className="workbench-pager mt-12 flex items-center justify-between gap-4 border-border border-t pt-8">
      {prev ? (
        <Link
          className="group flex min-w-0 flex-1 flex-col gap-1 rounded-lg border border-border px-4 py-3 text-sm transition-colors hover:bg-muted"
          data-direction="previous"
          to={prev.href}
        >
          <span className="text-muted-foreground text-xs">Previous</span>
          <span className="workbench-pager-title flex items-center gap-1.5 font-medium text-foreground">
            <span aria-hidden="true" className="workbench-pager-arrow">←</span>
            <span className="truncate">{prev.label}</span>
          </span>
        </Link>
      ) : (
        <div className="flex-1" />
      )}
      {next ? (
        <Link
          className="group flex min-w-0 flex-1 flex-col items-end gap-1 rounded-lg border border-border px-4 py-3 text-sm transition-colors hover:bg-muted"
          data-direction="next"
          to={next.href}
        >
          <span className="text-muted-foreground text-xs">Next</span>
          <span className="workbench-pager-title flex items-center gap-1.5 font-medium text-foreground">
            <span className="truncate">{next.label}</span>
            <span aria-hidden="true" className="workbench-pager-arrow">→</span>
          </span>
        </Link>
      ) : (
        <div className="flex-1" />
      )}
    </nav>
  );
}

import { ScrollArea } from "radix-ui";
import type * as React from "react";

import { cn } from "@/lib/utils";

function ScrollAreaRoot({
  className,
  children,
  ...props
}: React.ComponentProps<typeof ScrollArea.Root>) {
  return (
    <ScrollArea.Root className={cn("relative overflow-hidden", className)} {...props}>
      <ScrollArea.Viewport className="size-full rounded-[inherit]">{children}</ScrollArea.Viewport>
      <ScrollBar />
      <ScrollArea.Corner />
    </ScrollArea.Root>
  );
}

function ScrollBar({
  className,
  orientation = "vertical",
  ...props
}: React.ComponentProps<typeof ScrollArea.ScrollAreaScrollbar>) {
  return (
    <ScrollArea.ScrollAreaScrollbar
      className={cn(
        "flex touch-none select-none p-0.5 transition-colors",
        orientation === "vertical" && "h-full w-2.5 border-l border-l-transparent",
        orientation === "horizontal" && "h-2.5 flex-col border-t border-t-transparent",
        className
      )}
      orientation={orientation}
      {...props}
    >
      <ScrollArea.ScrollAreaThumb className="relative flex-1 rounded-full bg-border" />
    </ScrollArea.ScrollAreaScrollbar>
  );
}

export { ScrollAreaRoot as ScrollArea };

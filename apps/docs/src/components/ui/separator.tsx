import { Separator } from "radix-ui";
import type * as React from "react";

import { cn } from "@/lib/utils";

function AppSeparator({
  className,
  decorative = true,
  orientation = "horizontal",
  ...props
}: React.ComponentProps<typeof Separator.Root>) {
  return (
    <Separator.Root
      className={cn(
        "shrink-0 bg-border",
        orientation === "horizontal" ? "h-px w-full" : "h-full w-px",
        className
      )}
      decorative={decorative}
      orientation={orientation}
      {...props}
    />
  );
}

export { AppSeparator as Separator };

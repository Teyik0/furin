"use client";

import { Link } from "@teyik0/furin/link";
import { Menu } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import { DOCS_NAV } from "@/lib/docs";

export function DocsMobileNav() {
  const [open, setOpen] = useState(false);

  return (
    <Sheet onOpenChange={setOpen} open={open}>
      <SheetTrigger asChild>
        <Button className="w-full justify-start gap-2" size="sm" type="button" variant="outline">
          <Menu className="size-4" />
          Browse docs
        </Button>
      </SheetTrigger>
      <SheetContent className="p-0" side="left">
        <SheetHeader>
          <SheetTitle>Documentation</SheetTitle>
          <SheetDescription>Jump to any page from the current docs tree.</SheetDescription>
        </SheetHeader>
        <ScrollArea className="h-full px-5 pb-6">
          <nav className="space-y-6 py-4">
            {DOCS_NAV.map((section) => (
              <div key={section.title}>
                <p className="mb-2 font-semibold text-foreground text-xs uppercase tracking-[0.24em]">
                  {section.title}
                </p>
                <ul className="space-y-1">
                  {section.items.map((item) => (
                    <li key={item.href}>
                      <SheetClose asChild>
                        <Link
                          activeProps={({ isActive }) => ({
                            className: isActive
                              ? "block rounded-lg px-3 py-2 text-sm transition-colors bg-accent text-foreground"
                              : "block rounded-lg px-3 py-2 text-sm transition-colors text-muted-foreground hover:bg-muted hover:text-foreground",
                          })}
                          onClick={() => setOpen(false)}
                          to={item.href}
                        >
                          {item.label}
                        </Link>
                      </SheetClose>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </nav>
        </ScrollArea>
      </SheetContent>
    </Sheet>
  );
}

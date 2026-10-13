import * as React from "react";
import { cn } from "@/lib/utils";

// A panel on the page: a model, a variant, a stat.
function Card({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card"
      className={cn("flex min-w-0 flex-col rounded-2xl border border-border bg-card px-5 py-[1.1rem] text-card-foreground shadow-panel", className)}
      {...props}
    />
  );
}

export { Card };

"use client";

import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";
import { Toggle as TogglePrimitive } from "radix-ui";

const toggleVariants = cva(
  "inline-flex cursor-pointer items-center whitespace-nowrap select-none disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        // A colored filter: a GPU (its hue-* class gives the color), or
        // hiding deprecated models.
        tint: "tint tint-hover tint-pressed min-h-[34px] gap-[0.35rem] rounded-md px-3 py-[0.35rem] text-[0.85rem] font-medium transition-[background-color,border-color,box-shadow] duration-150",
        // One choice of a segmented control.
        segment:
          "min-h-8 gap-[0.35rem] rounded-chip px-[0.6rem] text-[0.84rem] text-muted-foreground hover:text-foreground focus-visible:outline-offset-1 data-[state=on]:bg-accent data-[state=on]:text-primary [&_svg]:size-[15px]",
      },
    },
    defaultVariants: {
      variant: "tint",
    },
  },
);

function Toggle({ className, variant = "tint", ...props }: React.ComponentProps<typeof TogglePrimitive.Root> & VariantProps<typeof toggleVariants>) {
  return <TogglePrimitive.Root data-slot="toggle" className={cn(toggleVariants({ variant, className }))} {...props} />;
}

export { Toggle, toggleVariants };

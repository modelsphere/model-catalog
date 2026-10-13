import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";
import { Slot } from "radix-ui";

const buttonVariants = cva(
  "inline-flex shrink-0 items-center whitespace-nowrap transition-colors disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        // Bordered, on the card: perf reports, links, sources, the theme.
        outline:
          "gap-[0.4rem] rounded-md border border-input bg-card text-foreground hover:border-primary hover:text-primary hover:no-underline [&_svg]:size-[15px]",
        // Quiet, for a secondary action: Reset.
        ghost: "text-muted-foreground hover:text-foreground hover:underline",
        // An inline link with an icon: the table's links, a pair's report.
        link: "gap-[0.3rem] text-primary hover:underline [&_svg]:size-[14px]",
        // No chrome at all: the table's sort headers.
        bare: "gap-1 text-inherit",
      },
      size: {
        default: "px-3 py-[0.35rem] text-[0.84rem]",
        sm: "px-[0.55rem] py-[0.2rem] text-[0.8rem]",
        none: "",
      },
    },
    defaultVariants: {
      variant: "outline",
      size: "default",
    },
  },
);

function Button({
  className,
  variant = "outline",
  size = "default",
  asChild = false,
  ...props
}: React.ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean;
  }) {
  const Comp = asChild ? Slot.Root : "button";

  return <Comp data-slot="button" data-variant={variant} data-size={size} className={cn(buttonVariants({ variant, size, className }))} {...props} />;
}

export { Button, buttonVariants };

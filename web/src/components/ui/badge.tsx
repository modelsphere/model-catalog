import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";
import { Slot } from "radix-ui";

// Roles and status in small caps.
const label = "inline-block rounded-sm border px-[0.4rem] text-[0.66rem] leading-[1.45] font-semibold tracking-[0.04em] uppercase";

const badgeVariants = cva("", {
  variants: {
    variant: {
      default: `${label} tint hue-grey`,
      // OPTIMIZED and DEPRECATED carry the color; DEFAULT and BASELINE step
      // back to a quiet outline, still 7:1 text.
      optimized: `${label} tint hue-green`,
      deprecated: `${label} tint hue-red`,
      quiet: `${label} border-border bg-transparent text-muted-foreground`,
      // A filter chip: a family (neutral), tag or GPU, its hue given by a
      // hue-* class.
      chip: "tint tint-hover hue-grey rounded-chip px-[0.55rem] py-[0.05rem] text-[0.75rem] leading-[1.5] whitespace-nowrap hover:no-underline",
      // A GPU's name inside a hardware line, or a variant's topology.
      gpu: "tint inline-block rounded-sm px-[0.4em] leading-[1.3] font-semibold",
    },
  },
  defaultVariants: {
    variant: "default",
  },
});

function Badge({
  className,
  variant = "default",
  asChild = false,
  ...props
}: React.ComponentProps<"span"> & VariantProps<typeof badgeVariants> & { asChild?: boolean }) {
  const Comp = asChild ? Slot.Root : "span";

  return <Comp data-slot="badge" data-variant={variant} className={cn(badgeVariants({ variant }), className)} {...props} />;
}

export { Badge, badgeVariants };

import { cn } from "@/lib/utils";

function Kbd({ className, ...props }: React.ComponentProps<"kbd">) {
  return (
    <kbd
      data-slot="kbd"
      className={cn(
        "pointer-events-none inline-flex items-center rounded-[4px] border border-border px-[0.3rem] font-mono text-[0.72rem] text-faint select-none",
        className,
      )}
      {...props}
    />
  );
}

export { Kbd };

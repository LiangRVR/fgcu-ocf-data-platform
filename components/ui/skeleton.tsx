import type { HTMLAttributes } from "react";
import { cn } from "@/lib/utils/cn";

function Skeleton({
  className,
  ...props
}: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn("rounded-md bg-muted motion-safe:animate-pulse motion-reduce:animate-none", className)}
      {...props}
    />
  );
}

export { Skeleton };

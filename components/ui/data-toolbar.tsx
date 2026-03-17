import type { ReactNode } from "react";
import { AppCard, AppCardContent } from "@/components/ui/app-card";
import { cn } from "@/lib/utils/cn";

interface DataToolbarProps {
  leading?: ReactNode;
  trailing?: ReactNode;
  className?: string;
}

export function DataToolbar({ leading, trailing, className }: DataToolbarProps) {
  return (
    <AppCard variant="soft" className={className}>
      <AppCardContent className={cn("flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between") }>
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-3">{leading}</div>
        <div className="flex shrink-0 flex-wrap items-center gap-2">{trailing}</div>
      </AppCardContent>
    </AppCard>
  );
}

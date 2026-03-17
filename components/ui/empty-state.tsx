import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { AppCard, AppCardContent } from "@/components/ui/app-card";
import { cn } from "@/lib/utils/cn";

interface EmptyStateProps {
  icon: LucideIcon;
  title: string;
  description: string;
  action?: ReactNode;
  className?: string;
  compact?: boolean;
}

export function EmptyState({ icon: Icon, title, description, action, className, compact = false }: EmptyStateProps) {
  return (
    <AppCard variant="soft" className={cn(className)}>
      <AppCardContent
        className={cn(
          "flex flex-col items-center justify-center text-center",
          compact ? "gap-3 py-10" : "gap-4 py-14"
        )}
      >
        <div className={cn("flex items-center justify-center rounded-full bg-slate-100 text-slate-400", compact ? "h-14 w-14" : "h-18 w-18") }>
          <Icon className={compact ? "h-7 w-7" : "h-9 w-9"} />
        </div>
        <div className="space-y-1.5">
          <h3 className="text-lg font-semibold text-slate-900">{title}</h3>
          <p className="max-w-md text-sm text-slate-500">{description}</p>
        </div>
        {action ? <div className="pt-1">{action}</div> : null}
      </AppCardContent>
    </AppCard>
  );
}

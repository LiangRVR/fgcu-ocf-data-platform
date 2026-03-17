import type { ReactNode } from "react";
import { AppCard, AppCardContent, AppCardDescription, AppCardHeader, AppCardTitle } from "@/components/ui/app-card";
import { cn } from "@/lib/utils/cn";

interface DetailSectionProps {
  title: string;
  description?: string;
  icon?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  contentClassName?: string;
}

export function DetailSection({ title, description, icon, actions, children, className, contentClassName }: DetailSectionProps) {
  return (
    <AppCard variant="default" className={className}>
      <AppCardHeader className="flex flex-row items-start justify-between gap-4">
        <div className="space-y-1.5">
          <div className="flex items-center gap-2">
            {icon ? <span className="text-slate-400">{icon}</span> : null}
            <AppCardTitle>{title}</AppCardTitle>
          </div>
          {description ? <AppCardDescription>{description}</AppCardDescription> : null}
        </div>
        {actions ? <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div> : null}
      </AppCardHeader>
      <AppCardContent className={cn(contentClassName)}>{children}</AppCardContent>
    </AppCard>
  );
}

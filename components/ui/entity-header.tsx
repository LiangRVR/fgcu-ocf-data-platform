import type { ReactNode } from "react";
import { AppCard, AppCardContent } from "@/components/ui/app-card";
import { cn } from "@/lib/utils/cn";

interface EntityHeaderProps {
  title: string;
  description?: string;
  kicker?: string;
  badges?: ReactNode;
  meta?: ReactNode;
  actions?: ReactNode;
  summary?: ReactNode;
  className?: string;
}

export function EntityHeader({
  title,
  description,
  kicker,
  badges,
  meta,
  actions,
  summary,
  className,
}: EntityHeaderProps) {
  return (
    <AppCard variant="elevated" className={cn("overflow-hidden", className)}>
      <AppCardContent className="space-y-6 p-6 sm:p-7">
        <div className="flex flex-col gap-5 lg:flex-row lg:items-start lg:justify-between">
          <div className="max-w-3xl space-y-3">
            {kicker ? <p className="app-kicker">{kicker}</p> : null}
            <div className="space-y-2">
              <h1 className="text-3xl font-semibold tracking-tight text-slate-950 sm:text-4xl">{title}</h1>
              {description ? <p className="text-sm leading-6 text-slate-500 sm:text-base">{description}</p> : null}
            </div>
            {badges ? <div className="flex flex-wrap items-center gap-2">{badges}</div> : null}
            {meta ? <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-sm text-slate-500">{meta}</div> : null}
          </div>
          {actions ? <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div> : null}
        </div>
        {summary ? <div className="grid gap-3 border-t border-border/70 pt-5 sm:grid-cols-2 lg:grid-cols-4">{summary}</div> : null}
      </AppCardContent>
    </AppCard>
  );
}

import type { ReactNode } from "react";
import { cn } from "@/lib/utils/cn";

interface PageSectionProps {
  title: string;
  description?: string;
  kicker?: string;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  contentClassName?: string;
}

export function PageSection({
  title,
  description,
  kicker,
  actions,
  children,
  className,
  contentClassName,
}: PageSectionProps) {
  return (
    <section className={cn("space-y-6", className)}>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div className="max-w-2xl space-y-1.5">
          {kicker ? <p className="app-kicker">{kicker}</p> : null}
          <h2 className="text-xl font-semibold text-slate-950">{title}</h2>
          {description ? <p className="text-sm text-slate-500">{description}</p> : null}
        </div>
        {actions ? <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div> : null}
      </div>
      <div className={contentClassName}>{children}</div>
    </section>
  );
}

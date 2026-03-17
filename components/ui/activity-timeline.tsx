import Link from "next/link";
import type { ReactNode } from "react";
import { ArrowUpRight } from "lucide-react";
import { MetricBadge } from "@/components/ui/metric-badge";
import { cn } from "@/lib/utils/cn";

type ActivityTimelineTone = "slate" | "green" | "blue" | "amber" | "purple" | "red";

const toneClasses: Record<ActivityTimelineTone, { dot: string }> = {
  slate: { dot: "border-slate-200 bg-slate-100 text-slate-600" },
  green: { dot: "border-emerald-200 bg-emerald-100 text-emerald-700" },
  blue: { dot: "border-blue-200 bg-blue-100 text-blue-700" },
  amber: { dot: "border-amber-200 bg-amber-100 text-amber-700" },
  purple: { dot: "border-purple-200 bg-purple-100 text-purple-700" },
  red: { dot: "border-red-200 bg-red-100 text-red-700" },
};

export interface ActivityTimelineItem {
  id: string;
  title: string;
  description: string;
  timestamp: string;
  badge: string;
  tone?: ActivityTimelineTone;
  href?: string;
  icon?: ReactNode;
  meta?: string;
}

interface ActivityTimelineProps {
  items: ActivityTimelineItem[];
  className?: string;
}

export function ActivityTimeline({ items, className }: ActivityTimelineProps) {
  return (
    <ol className={cn("relative space-y-4 before:absolute before:bottom-2 before:left-[0.875rem] before:top-2 before:w-px before:bg-border/70", className)}>
      {items.map((item) => {
        const tone = item.tone ?? "slate";

        return (
          <li key={item.id} className="relative pl-10">
            <span
              className={cn(
                "absolute left-0 top-1 flex h-7 w-7 items-center justify-center rounded-full border bg-white",
                toneClasses[tone].dot
              )}
            >
              {item.icon}
            </span>

            <div className="rounded-2xl border border-border/70 bg-surface-subtle/70 p-4">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                <div className="min-w-0 space-y-1.5">
                  {item.href ? (
                    <Link
                      href={item.href}
                      className="inline-flex items-center gap-1 text-sm font-semibold text-slate-900 transition-colors hover:text-primary"
                    >
                      <span className="truncate">{item.title}</span>
                      <ArrowUpRight className="h-3.5 w-3.5 shrink-0" />
                    </Link>
                  ) : (
                    <p className="text-sm font-semibold text-slate-900">{item.title}</p>
                  )}

                  <p className="text-sm leading-6 text-slate-600">{item.description}</p>

                  {item.meta ? <p className="text-xs text-slate-400">{item.meta}</p> : null}
                </div>

                <div className="flex shrink-0 flex-wrap items-center gap-2 sm:justify-end">
                  <span className="text-xs font-medium uppercase tracking-[0.14em] text-slate-400">
                    {item.timestamp}
                  </span>
                  <MetricBadge tone={tone}>{item.badge}</MetricBadge>
                </div>
              </div>
            </div>
          </li>
        );
      })}
    </ol>
  );
}

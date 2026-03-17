import Link from "next/link";
import type { LucideIcon } from "lucide-react";
import { ArrowUpRight } from "lucide-react";
import { AppCard, AppCardContent } from "@/components/ui/app-card";
import { cn } from "@/lib/utils/cn";

const tones = {
  green: {
    well: "bg-emerald-50 text-emerald-700 ring-1 ring-emerald-100",
    metric: "text-slate-950",
    accent: "text-emerald-700",
  },
  blue: {
    well: "bg-blue-50 text-blue-700 ring-1 ring-blue-100",
    metric: "text-slate-950",
    accent: "text-blue-700",
  },
  amber: {
    well: "bg-amber-50 text-amber-700 ring-1 ring-amber-100",
    metric: "text-slate-950",
    accent: "text-amber-700",
  },
  violet: {
    well: "bg-violet-50 text-violet-700 ring-1 ring-violet-100",
    metric: "text-slate-950",
    accent: "text-violet-700",
  },
  rose: {
    well: "bg-rose-50 text-rose-700 ring-1 ring-rose-100",
    metric: "text-slate-950",
    accent: "text-rose-700",
  },
  slate: {
    well: "bg-slate-100 text-slate-700 ring-1 ring-slate-200",
    metric: "text-slate-950",
    accent: "text-slate-700",
  },
} as const;

interface StatCardProps {
  title: string;
  value: string | number;
  description?: string;
  trend?: string;
  eyebrow?: string;
  icon: LucideIcon;
  href?: string;
  tone?: keyof typeof tones;
  className?: string;
}

function StatCardInner({
  title,
  value,
  description,
  trend,
  eyebrow,
  icon: Icon,
  href,
  tone = "slate",
  className,
}: StatCardProps) {
  const color = tones[tone];

  return (
    <AppCard
      variant="default"
      className={cn(
        "group h-full overflow-hidden border-border/70",
        href && "motion-safe:hover:-translate-y-0.5 hover:border-emerald-200/90 hover:shadow-[0_20px_44px_-28px_rgba(5,95,70,0.26)]",
        className
      )}
    >
      <AppCardContent className="flex h-full min-h-32 flex-col justify-between gap-6 p-5 sm:p-6">
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-2">
            {eyebrow ? <p className="app-kicker">{eyebrow}</p> : null}
            <div className={cn("text-3xl font-semibold tracking-tight", color.metric)}>{value}</div>
            <div>
              <p className="text-sm font-medium text-slate-700">{title}</p>
              {description ? <p className="mt-1 text-xs text-slate-500">{description}</p> : null}
            </div>
          </div>
          <div className={cn("flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl", color.well)}>
            <Icon className="h-5 w-5" />
          </div>
        </div>
        {(trend || href) && (
          <div className="flex items-center justify-between gap-3 text-xs">
            <span className={cn("font-medium", trend ? color.accent : "text-slate-400")}>{trend ?? "View details"}</span>
            {href ? <ArrowUpRight className="h-4 w-4 text-slate-400 motion-safe:transition-transform motion-safe:group-hover:translate-x-0.5 motion-safe:group-hover:-translate-y-0.5" /> : null}
          </div>
        )}
      </AppCardContent>
    </AppCard>
  );
}

export function StatCard(props: StatCardProps) {
  if (!props.href) {
    return <StatCardInner {...props} />;
  }

  return (
    <Link href={props.href} className="block h-full">
      <StatCardInner {...props} />
    </Link>
  );
}

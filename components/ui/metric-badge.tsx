import { cva, type VariantProps } from "class-variance-authority";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils/cn";

const metricBadgeVariants = cva(
  "rounded-full border px-2.5 py-0.5 text-xs font-medium shadow-none",
  {
    variants: {
      tone: {
        slate: "border-slate-200 bg-slate-100 text-slate-700 hover:bg-slate-100",
        green: "border-emerald-200 bg-emerald-100 text-emerald-800 hover:bg-emerald-100",
        blue: "border-blue-200 bg-blue-100 text-blue-800 hover:bg-blue-100",
        amber: "border-amber-200 bg-amber-100 text-amber-900 hover:bg-amber-100",
        purple: "border-purple-200 bg-purple-100 text-purple-800 hover:bg-purple-100",
        red: "border-red-200 bg-red-100 text-red-700 hover:bg-red-100",
      },
    },
    defaultVariants: {
      tone: "slate",
    },
  }
);

interface MetricBadgeProps extends VariantProps<typeof metricBadgeVariants> {
  className?: string;
  children: React.ReactNode;
}

export function MetricBadge({ tone, className, children }: MetricBadgeProps) {
  return <Badge className={cn(metricBadgeVariants({ tone }), className)}>{children}</Badge>;
}

import type { ReactNode } from "react";
import { Skeleton } from "@/components/ui/skeleton";

interface PageHeaderProps {
  title: string;
  description?: string;
  eyebrow?: string;
  children?: ReactNode;
}

/**
 * Consistent page-level header with optional action slot on the right.
 */
export function PageHeader({ title, description, eyebrow, children }: PageHeaderProps) {
  return (
    <div className="mb-10 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
      <div className="max-w-2xl">
        {eyebrow && <p className="app-kicker mb-2">{eyebrow}</p>}
        <h1 className="text-3xl font-semibold tracking-tight text-slate-950 sm:text-4xl">{title}</h1>
        {description && (
          <p className="mt-2 text-sm leading-6 text-slate-500 sm:text-base">{description}</p>
        )}
      </div>
      {children && (
        <div className="flex shrink-0 flex-wrap items-center gap-2">{children}</div>
      )}
    </div>
  );
}

/**
 * Placeholder loading skeleton for a page header + content area.
 */
export function PageSkeleton() {
  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <Skeleton className="h-3 w-28" />
        <Skeleton className="h-7 w-48" />
        <Skeleton className="h-4 w-72" />
      </div>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-28 rounded-xl" />
        ))}
      </div>
      <Skeleton className="h-64 rounded-xl" />
    </div>
  );
}

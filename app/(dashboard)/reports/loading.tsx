import { AppCard, AppCardContent, AppCardHeader } from "@/components/ui/app-card";
import { Skeleton } from "@/components/ui/skeleton";

function ReportsHeaderSkeleton() {
  return (
    <div className="mb-8 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
      <div className="max-w-2xl space-y-3">
        <Skeleton className="h-3 w-24" />
        <Skeleton className="h-10 w-44" />
        <Skeleton className="h-4 w-full max-w-2xl" />
      </div>
      <div className="flex flex-wrap gap-2">
        <Skeleton className="h-8 w-24 rounded-full" />
        <Skeleton className="h-8 w-24 rounded-full" />
      </div>
    </div>
  );
}

function StatsSkeleton() {
  return (
    <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-5">
      {Array.from({ length: 5 }).map((_, index) => (
        <AppCard key={index}>
          <AppCardContent className="flex min-h-32 items-start justify-between gap-4 p-5 sm:p-6">
            <div className="flex-1 space-y-3">
              <Skeleton className="h-8 w-20" />
              <div className="space-y-2">
                <Skeleton className="h-4 w-28" />
                <Skeleton className="h-3 w-full max-w-32" />
              </div>
            </div>
            <Skeleton className="h-11 w-11 rounded-2xl" />
          </AppCardContent>
        </AppCard>
      ))}
    </div>
  );
}

function AnalyticsCardSkeleton({ tall = false }: { tall?: boolean }) {
  return (
    <AppCard>
      <AppCardHeader className="space-y-2">
        <Skeleton className="h-5 w-48" />
        <Skeleton className="h-4 w-full max-w-sm" />
      </AppCardHeader>
      <AppCardContent className="space-y-4">
        <div className="space-y-3">
          {Array.from({ length: tall ? 5 : 4 }).map((_, index) => (
            <div key={index} className="space-y-2">
              <div className="flex items-center justify-between gap-3">
                <Skeleton className="h-6 w-28 rounded-full" />
                <Skeleton className="h-4 w-12" />
              </div>
              <Skeleton className="h-2 w-full rounded-full" />
            </div>
          ))}
        </div>
      </AppCardContent>
    </AppCard>
  );
}

function TableCardSkeleton() {
  return (
    <AppCard>
      <AppCardHeader className="space-y-2">
        <Skeleton className="h-5 w-64" />
        <Skeleton className="h-4 w-full max-w-md" />
      </AppCardHeader>
      <AppCardContent className="space-y-3">
        {Array.from({ length: 5 }).map((_, index) => (
          <div key={index} className="flex items-center justify-between gap-3 rounded-2xl border border-border/70 p-4">
            <div className="min-w-0 flex-1 space-y-2">
              <Skeleton className="h-4 w-40" />
              <Skeleton className="h-3 w-24" />
            </div>
            <div className="flex flex-wrap gap-2">
              <Skeleton className="h-6 w-16 rounded-full" />
              <Skeleton className="h-6 w-20 rounded-full" />
            </div>
          </div>
        ))}
      </AppCardContent>
    </AppCard>
  );
}

export default function ReportsLoading() {
  return (
    <div className="space-y-8">
      <ReportsHeaderSkeleton />
      <StatsSkeleton />
      <div className="grid gap-6 md:grid-cols-2">
        <AnalyticsCardSkeleton />
        <AnalyticsCardSkeleton />
      </div>
      <TableCardSkeleton />
      <TableCardSkeleton />
      <AnalyticsCardSkeleton tall />
      <div className="grid gap-6 md:grid-cols-2">
        <TableCardSkeleton />
        <TableCardSkeleton />
      </div>
    </div>
  );
}

import { AppCard, AppCardContent, AppCardHeader } from "@/components/ui/app-card";
import { Skeleton } from "@/components/ui/skeleton";

function HeaderSkeleton() {
  return (
    <div className="mb-8 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
      <div className="max-w-2xl space-y-3">
        <Skeleton className="h-3 w-24" />
        <Skeleton className="h-10 w-56" />
        <Skeleton className="h-4 w-full max-w-xl" />
      </div>
      <div className="flex flex-wrap gap-2">
        <Skeleton className="h-8 w-24 rounded-full" />
        <Skeleton className="h-8 w-24 rounded-full" />
        <Skeleton className="h-9 w-32 rounded-full" />
      </div>
    </div>
  );
}

function StatGridSkeleton() {
  return (
    <div className="mb-8 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
      {Array.from({ length: 4 }).map((_, index) => (
        <AppCard key={index}>
          <AppCardContent className="flex min-h-32 items-start justify-between gap-4 p-5 sm:p-6">
            <div className="flex-1 space-y-3">
              <Skeleton className="h-8 w-20" />
              <div className="space-y-2">
                <Skeleton className="h-4 w-28" />
                <Skeleton className="h-3 w-full max-w-48" />
              </div>
            </div>
            <Skeleton className="h-11 w-11 rounded-2xl" />
          </AppCardContent>
        </AppCard>
      ))}
    </div>
  );
}

function PanelSkeleton() {
  return (
    <AppCard>
      <AppCardHeader className="space-y-2">
        <Skeleton className="h-5 w-40" />
        <Skeleton className="h-4 w-full max-w-lg" />
      </AppCardHeader>
      <AppCardContent className="space-y-4">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex flex-1 flex-wrap gap-3">
            <Skeleton className="h-10 w-full max-w-sm" />
            <Skeleton className="h-10 w-40" />
            <Skeleton className="h-10 w-40" />
          </div>
          <div className="flex flex-wrap gap-2">
            <Skeleton className="h-8 w-24 rounded-full" />
            <Skeleton className="h-8 w-28 rounded-full" />
          </div>
        </div>
        <Skeleton className="h-104 w-full rounded-2xl" />
      </AppCardContent>
    </AppCard>
  );
}

export default function DashboardLoading() {
  return (
    <div className="space-y-8">
      <HeaderSkeleton />
      <StatGridSkeleton />
      <PanelSkeleton />
    </div>
  );
}

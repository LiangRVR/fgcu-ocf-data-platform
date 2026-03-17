import { AppCard, AppCardContent, AppCardHeader } from "@/components/ui/app-card";
import { Skeleton } from "@/components/ui/skeleton";

function EntityHeaderSkeleton() {
  return (
    <AppCard variant="elevated" className="overflow-hidden">
      <AppCardContent className="space-y-6 p-6 sm:p-7">
        <div className="flex flex-col gap-5 lg:flex-row lg:items-start lg:justify-between">
          <div className="max-w-3xl space-y-3">
            <Skeleton className="h-3 w-24" />
            <div className="space-y-2">
              <Skeleton className="h-10 w-56" />
              <Skeleton className="h-4 w-full max-w-xl" />
            </div>
            <div className="flex flex-wrap gap-2">
              <Skeleton className="h-8 w-24 rounded-full" />
              <Skeleton className="h-8 w-28 rounded-full" />
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            <Skeleton className="h-9 w-32 rounded-full" />
            <Skeleton className="h-9 w-28 rounded-full" />
          </div>
        </div>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {Array.from({ length: 3 }).map((_, index) => (
            <div key={index} className="rounded-2xl border border-border/70 bg-surface-subtle px-4 py-3">
              <Skeleton className="h-3 w-20" />
              <Skeleton className="mt-3 h-8 w-16" />
            </div>
          ))}
        </div>
      </AppCardContent>
    </AppCard>
  );
}

function MeetingsSkeleton() {
  return (
    <AppCard>
      <AppCardHeader className="flex flex-row items-center justify-between gap-4">
        <div className="space-y-2">
          <Skeleton className="h-6 w-44" />
          <Skeleton className="h-4 w-full max-w-sm" />
        </div>
        <Skeleton className="h-8 w-28 rounded-full" />
      </AppCardHeader>
      <AppCardContent className="space-y-3">
        {Array.from({ length: 4 }).map((_, index) => (
          <div key={index} className="rounded-2xl border border-border/70 p-4">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0 flex-1 space-y-2">
                <Skeleton className="h-4 w-40" />
                <Skeleton className="h-3 w-28" />
              </div>
              <Skeleton className="h-6 w-20 rounded-full" />
            </div>
            <div className="mt-3 flex flex-wrap gap-2">
              <Skeleton className="h-6 w-20 rounded-full" />
              <Skeleton className="h-6 w-24 rounded-full" />
            </div>
            <Skeleton className="mt-3 h-3 w-full max-w-2xl" />
          </div>
        ))}
      </AppCardContent>
    </AppCard>
  );
}

export default function AdvisorDetailLoading() {
  return (
    <div className="space-y-6">
      <EntityHeaderSkeleton />
      <MeetingsSkeleton />
    </div>
  );
}

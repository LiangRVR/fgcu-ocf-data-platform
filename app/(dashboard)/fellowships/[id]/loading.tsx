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
              <Skeleton className="h-10 w-64" />
              <Skeleton className="h-4 w-40" />
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            <Skeleton className="h-9 w-36 rounded-full" />
            <Skeleton className="h-9 w-24 rounded-full" />
          </div>
        </div>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {Array.from({ length: 4 }).map((_, index) => (
            <div key={index} className="rounded-2xl border border-border/70 bg-surface-subtle px-4 py-3">
              <Skeleton className="h-3 w-24" />
              <Skeleton className="mt-3 h-8 w-16" />
            </div>
          ))}
        </div>
      </AppCardContent>
    </AppCard>
  );
}

function SectionSkeleton({ chips = false }: { chips?: boolean }) {
  return (
    <AppCard>
      <AppCardHeader className="flex flex-row items-center justify-between gap-4">
        <div className="space-y-2">
          <Skeleton className="h-6 w-40" />
          <Skeleton className="h-4 w-full max-w-sm" />
        </div>
        <Skeleton className="h-8 w-28 rounded-full" />
      </AppCardHeader>
      <AppCardContent className="space-y-3">
        {chips ? (
          <div className="flex flex-wrap gap-2">
            {Array.from({ length: 5 }).map((_, index) => (
              <Skeleton key={index} className="h-9 w-32 rounded-full" />
            ))}
          </div>
        ) : (
          Array.from({ length: 4 }).map((_, index) => (
            <div key={index} className="rounded-2xl border border-border/70 p-4">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 flex-1 space-y-2">
                  <Skeleton className="h-4 w-40" />
                  <Skeleton className="h-3 w-28" />
                </div>
                <Skeleton className="h-6 w-20 rounded-full" />
              </div>
              <div className="mt-3 flex flex-wrap gap-2">
                <Skeleton className="h-6 w-24 rounded-full" />
                <Skeleton className="h-6 w-16 rounded-full" />
              </div>
            </div>
          ))
        )}
      </AppCardContent>
    </AppCard>
  );
}

export default function FellowshipDetailLoading() {
  return (
    <div className="space-y-6">
      <EntityHeaderSkeleton />
      <SectionSkeleton />
      <SectionSkeleton chips />
    </div>
  );
}

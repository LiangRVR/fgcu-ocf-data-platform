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
              <Skeleton className="h-10 w-52" />
              <Skeleton className="h-4 w-full max-w-xl" />
            </div>
            <div className="flex flex-wrap gap-2">
              <Skeleton className="h-8 w-24 rounded-full" />
              <Skeleton className="h-8 w-28 rounded-full" />
            </div>
          </div>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {Array.from({ length: 4 }).map((_, index) => (
              <div key={index} className="rounded-2xl border border-border/70 bg-surface-subtle px-4 py-3">
                <Skeleton className="h-3 w-20" />
                <Skeleton className="mt-3 h-8 w-16" />
              </div>
            ))}
          </div>
        </div>
      </AppCardContent>
    </AppCard>
  );
}

function FormSectionSkeleton() {
  return (
    <AppCard>
      <AppCardHeader className="space-y-2">
        <Skeleton className="h-6 w-40" />
        <Skeleton className="h-4 w-full max-w-md" />
      </AppCardHeader>
      <AppCardContent className="grid gap-4 md:grid-cols-2">
        {Array.from({ length: 4 }).map((_, index) => (
          <div key={index} className="space-y-2">
            <Skeleton className="h-3 w-24" />
            <Skeleton className="h-10 w-full rounded-xl" />
          </div>
        ))}
        <div className="md:col-span-2 flex justify-end">
          <Skeleton className="h-10 w-32 rounded-full" />
        </div>
      </AppCardContent>
    </AppCard>
  );
}

function TableSectionSkeleton() {
  return (
    <AppCard>
      <AppCardHeader className="space-y-4">
        <div className="space-y-2">
          <Skeleton className="h-6 w-44" />
          <Skeleton className="h-4 w-full max-w-md" />
        </div>
        <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex flex-1 flex-wrap gap-3">
            <Skeleton className="h-10 w-full max-w-sm rounded-xl" />
            <Skeleton className="h-10 w-36 rounded-xl" />
            <Skeleton className="h-10 w-36 rounded-xl" />
          </div>
        </div>
      </AppCardHeader>
      <AppCardContent className="space-y-3">
        {Array.from({ length: 5 }).map((_, index) => (
          <div key={index} className="rounded-2xl border border-border/70 p-4">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0 flex-1 space-y-2">
                <Skeleton className="h-4 w-40" />
                <Skeleton className="h-3 w-full max-w-xs" />
              </div>
              <Skeleton className="h-6 w-20 rounded-full" />
            </div>
            <div className="mt-3 flex flex-wrap gap-2">
              <Skeleton className="h-6 w-20 rounded-full" />
              <Skeleton className="h-6 w-24 rounded-full" />
            </div>
          </div>
        ))}
      </AppCardContent>
    </AppCard>
  );
}

export default function AccountLoading() {
  return (
    <div className="space-y-6">
      <EntityHeaderSkeleton />
      <div className="grid gap-6 xl:grid-cols-[minmax(0,0.95fr)_minmax(0,1.05fr)]">
        <div className="space-y-6">
          <FormSectionSkeleton />
          <FormSectionSkeleton />
        </div>
        <div className="space-y-6">
          <TableSectionSkeleton />
          <TableSectionSkeleton />
        </div>
      </div>
    </div>
  );
}

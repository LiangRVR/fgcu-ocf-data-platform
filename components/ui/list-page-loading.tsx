import { AppCard, AppCardContent, AppCardHeader } from "@/components/ui/app-card";
import { Skeleton } from "@/components/ui/skeleton";

interface ListPageLoadingProps {
  stats?: number;
  headerBadges?: number;
  pills?: number;
  showBanner?: boolean;
  toolbarFilters?: number;
  rows?: number;
}

export function ListPageLoading({
  stats = 4,
  headerBadges = 3,
  pills = 0,
  showBanner = false,
  toolbarFilters = 2,
  rows = 6,
}: ListPageLoadingProps) {
  return (
    <div className="space-y-8">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div className="max-w-2xl space-y-3">
          <Skeleton className="h-3 w-24" />
          <Skeleton className="h-10 w-48" />
          <Skeleton className="h-4 w-full max-w-2xl" />
        </div>
        <div className="flex flex-wrap gap-2">
          {Array.from({ length: headerBadges }).map((_, index) => (
            <Skeleton key={index} className="h-8 w-24 rounded-full" />
          ))}
        </div>
      </div>

      {pills > 0 ? (
        <div className="flex flex-wrap gap-2">
          {Array.from({ length: pills }).map((_, index) => (
            <Skeleton key={index} className="h-8 w-28 rounded-full" />
          ))}
        </div>
      ) : null}

      <AppCard>
        <AppCardContent className="grid gap-4 p-5 sm:grid-cols-2 xl:grid-cols-4 sm:p-6">
          {Array.from({ length: stats }).map((_, index) => (
            <div key={index} className="flex min-h-28 items-start justify-between gap-4 rounded-2xl border border-border/60 bg-card px-5 py-4">
              <div className="flex-1 space-y-3">
                <Skeleton className="h-8 w-20" />
                <div className="space-y-2">
                  <Skeleton className="h-4 w-28" />
                  <Skeleton className="h-3 w-full max-w-40" />
                </div>
              </div>
              <Skeleton className="h-11 w-11 rounded-2xl" />
            </div>
          ))}
        </AppCardContent>
      </AppCard>

      {showBanner ? (
        <AppCard variant="soft">
          <AppCardContent className="flex flex-col gap-3 p-4 sm:flex-row sm:items-start sm:justify-between">
            <div className="space-y-2">
              <Skeleton className="h-4 w-40" />
              <Skeleton className="h-3 w-full max-w-xl" />
            </div>
            <Skeleton className="h-8 w-24 rounded-full" />
          </AppCardContent>
        </AppCard>
      ) : null}

      <AppCard>
        <AppCardHeader className="space-y-4">
          <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
            <div className="flex flex-1 flex-wrap gap-3">
              <Skeleton className="h-10 w-full max-w-sm rounded-xl" />
              {Array.from({ length: toolbarFilters }).map((_, index) => (
                <Skeleton key={index} className="h-10 w-36 rounded-xl" />
              ))}
            </div>
            <div className="flex flex-wrap gap-2">
              <Skeleton className="h-9 w-24 rounded-full" />
              <Skeleton className="h-9 w-32 rounded-full" />
            </div>
          </div>
        </AppCardHeader>
        <AppCardContent className="space-y-3">
          {Array.from({ length: rows }).map((_, index) => (
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
                <Skeleton className="h-6 w-16 rounded-full" />
              </div>
            </div>
          ))}
        </AppCardContent>
      </AppCard>
    </div>
  );
}

import { LoadingRow, Skeleton } from "@/components/ui/skeleton";

/** Journey home: banner, today's mission card, day grid. */
export default function JourneyLoading() {
  return (
    <div className="space-y-6">
      <LoadingRow label="Loading your journey…" />
      <div className="rounded-2xl border border-line bg-paper p-5 sm:p-6 space-y-3">
        <Skeleton className="h-4 w-32" />
        <Skeleton className="h-8 w-2/3" />
        <Skeleton className="h-2 w-full rounded-full" />
      </div>
      <div className="rounded-2xl border border-line bg-paper p-5 sm:p-6 space-y-3">
        <Skeleton className="h-3 w-24" />
        <Skeleton className="h-6 w-1/2" />
        <Skeleton className="h-4 w-3/4" />
        <Skeleton className="h-10 w-40 rounded-xl" />
      </div>
      <div className="grid grid-cols-5 sm:grid-cols-7 md:grid-cols-10 gap-2">
        {Array.from({ length: 30 }).map((_, i) => (
          <Skeleton key={i} className="aspect-square rounded-xl" />
        ))}
      </div>
    </div>
  );
}

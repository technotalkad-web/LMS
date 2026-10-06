import { KpiStripSkeleton, LoadingRow, Skeleton, TableSkeleton } from "@/components/ui/skeleton";

/** Team Performance (Report Card): score + attention cards, then the roster. */
export default function TeamPerformanceLoading() {
  return (
    <div className="space-y-6">
      <LoadingRow label="Loading your team…" />
      <Skeleton className="h-8 w-64" />
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <Skeleton className="h-48 rounded-2xl" />
        <Skeleton className="h-48 rounded-2xl lg:col-span-2" />
      </div>
      <KpiStripSkeleton count={4} />
      <TableSkeleton rows={8} />
    </div>
  );
}

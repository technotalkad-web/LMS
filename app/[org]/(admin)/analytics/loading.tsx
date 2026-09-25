import { KpiStripSkeleton, LoadingRow, PageHeaderSkeleton, Skeleton, TableSkeleton } from "@/components/ui/skeleton";

/** Analytics: filters, KPI strip, two chart panels, at-risk table. */
export default function AnalyticsLoading() {
  return (
    <div>
      <LoadingRow label="Crunching the numbers…" />
      <PageHeaderSkeleton action />
      <div className="flex flex-wrap gap-2 mb-6">
        {Array.from({ length: 5 }).map((_, i) => (
          <Skeleton key={i} className="h-9 w-32 rounded-lg" />
        ))}
      </div>
      <KpiStripSkeleton count={4} />
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-6">
        <Skeleton className="h-64 rounded-xl" />
        <Skeleton className="h-64 rounded-xl" />
      </div>
      <TableSkeleton rows={6} />
    </div>
  );
}

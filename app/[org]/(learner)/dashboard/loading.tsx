import { KpiStripSkeleton, CardGridSkeleton, Skeleton } from "@/components/ui/skeleton";

export default function DashboardLoading() {
  return (
    <div>
      <Skeleton className="h-8 w-64 mb-6" />
      <KpiStripSkeleton count={4} />
      <Skeleton className="h-5 w-40 mb-3" />
      <CardGridSkeleton count={6} />
    </div>
  );
}

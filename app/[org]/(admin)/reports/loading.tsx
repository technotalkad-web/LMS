import {
  PageHeaderSkeleton,
  KpiStripSkeleton,
  TableSkeleton,
} from "@/components/ui/skeleton";

export default function ReportsLoading() {
  return (
    <div>
      <PageHeaderSkeleton />
      <KpiStripSkeleton count={5} />
      <div className="space-y-6">
        <TableSkeleton rows={6} />
        <TableSkeleton rows={6} />
      </div>
    </div>
  );
}

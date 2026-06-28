import {
  PageHeaderSkeleton,
  KpiStripSkeleton,
  TableSkeleton,
} from "@/components/ui/skeleton";

export default function UsersLoading() {
  return (
    <div>
      <PageHeaderSkeleton action />
      <KpiStripSkeleton count={5} />
      <TableSkeleton rows={8} />
    </div>
  );
}

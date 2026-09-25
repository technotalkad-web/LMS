import { LoadingRow, PageHeaderSkeleton, Skeleton, TableSkeleton } from "@/components/ui/skeleton";

/** Course admin page: header, language packages, version history. */
export default function LibraryCourseLoading() {
  return (
    <div>
      <LoadingRow label="Loading course…" />
      <PageHeaderSkeleton action />
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-6">
        <Skeleton className="h-32 rounded-xl" />
        <Skeleton className="h-32 rounded-xl" />
      </div>
      <Skeleton className="h-5 w-40 mb-3" />
      <TableSkeleton rows={5} />
    </div>
  );
}

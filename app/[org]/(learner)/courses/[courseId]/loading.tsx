import { LoadingRow, Skeleton } from "@/components/ui/skeleton";

/** Course detail: hero, action row, attempt history. */
export default function CourseLoading() {
  return (
    <div className="space-y-6">
      <LoadingRow label="Loading course…" />
      <div className="rounded-2xl border border-line bg-paper overflow-hidden">
        <Skeleton className="h-40 sm:h-56 w-full rounded-none" />
        <div className="p-5 sm:p-6 space-y-3">
          <Skeleton className="h-7 w-2/3" />
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-5/6" />
          <div className="flex gap-3 pt-2">
            <Skeleton className="h-11 w-36 rounded-xl" />
            <Skeleton className="h-11 w-28 rounded-xl" />
          </div>
        </div>
      </div>
      <div className="rounded-2xl border border-line bg-paper divide-y divide-line">
        {Array.from({ length: 3 }).map((_, i) => (
          <div key={i} className="flex items-center gap-4 px-5 py-4">
            <Skeleton className="h-4 w-1/4" />
            <Skeleton className="h-4 w-1/5" />
            <Skeleton className="h-4 w-16 ml-auto" />
          </div>
        ))}
      </div>
    </div>
  );
}

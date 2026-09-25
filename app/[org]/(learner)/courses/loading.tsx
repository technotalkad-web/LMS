import { CardGridSkeleton, LoadingRow, Skeleton } from "@/components/ui/skeleton";

/** My courses: heading, filter tabs, card grid. */
export default function CoursesLoading() {
  return (
    <div>
      <LoadingRow label="Loading your courses…" />
      <Skeleton className="h-8 w-48 mb-2" />
      <Skeleton className="h-4 w-72 mb-6" />
      <div className="flex gap-2 mb-6">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-9 w-28 rounded-full" />
        ))}
      </div>
      <CardGridSkeleton count={6} />
    </div>
  );
}

import { LoadingRow, Skeleton, TableSkeleton } from "@/components/ui/skeleton";

/** Leaderboard: podium then the ranked table. */
export default function LeaderboardLoading() {
  return (
    <div className="space-y-6">
      <LoadingRow label="Loading leaderboard…" />
      <Skeleton className="h-8 w-56" />
      <div className="grid grid-cols-3 gap-3 items-end">
        <Skeleton className="h-28 rounded-2xl" />
        <Skeleton className="h-36 rounded-2xl" />
        <Skeleton className="h-24 rounded-2xl" />
      </div>
      <TableSkeleton rows={8} />
    </div>
  );
}

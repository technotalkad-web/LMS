import { PageHeaderSkeleton, CardGridSkeleton } from "@/components/ui/skeleton";

export default function LearningPathsLoading() {
  return (
    <div>
      <PageHeaderSkeleton action />
      <CardGridSkeleton count={6} />
    </div>
  );
}

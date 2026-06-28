import {
  PageHeaderSkeleton,
  KpiStripSkeleton,
  CardGridSkeleton,
} from "@/components/ui/skeleton";

export default function LibraryLoading() {
  return (
    <div>
      <PageHeaderSkeleton action />
      <KpiStripSkeleton count={4} />
      <CardGridSkeleton count={6} />
    </div>
  );
}

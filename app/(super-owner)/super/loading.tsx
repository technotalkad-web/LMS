import { PageSkeleton } from "@/components/ui/skeleton";

/** Platform-owner console loading boundary (never the full-screen loader). */
export default function SuperLoading() {
  return <PageSkeleton table />;
}

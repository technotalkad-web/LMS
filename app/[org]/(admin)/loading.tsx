import { PageSkeleton } from "@/components/ui/skeleton";

/** Admin-group loading boundary: sidebar stays, content shows a table
 *  skeleton + small brand indicator for pages without a bespoke one. */
export default function AdminLoading() {
  return <PageSkeleton table />;
}

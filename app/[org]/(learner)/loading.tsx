import { PageSkeleton } from "@/components/ui/skeleton";

/**
 * Learner-group loading boundary: keeps the top nav in place and shows a
 * skeleton + small brand indicator for any learner page without a bespoke
 * loading.tsx. Never a full-screen loader inside the app shell.
 */
export default function LearnerLoading() {
  return <PageSkeleton cards={6} />;
}

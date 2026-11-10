import { LoadingRow } from "@/components/ui/skeleton";

/**
 * The continue address's wait (ADR 0019 step 4): shown while the page reads
 * whether the last module's result is stored. Inside the learner layout,
 * never a full-screen overlay.
 */
export default function ContinueLoading() {
  return (
    <div data-testid="continue-saving" className="max-w-xl mx-auto py-10">
      <LoadingRow label="Saving your result…" />
      <p className="text-sm text-muted">Your result is being saved. The next step opens in a moment.</p>
    </div>
  );
}

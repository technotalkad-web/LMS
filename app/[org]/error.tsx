"use client";

import { RouteError } from "@/components/ui/route-error";

/**
 * The error boundary above the two group layouts. An error file does not
 * catch the layout of its own folder, so (admin)/error.tsx and
 * (learner)/error.tsx never see an error thrown in (admin)/layout.tsx or
 * (learner)/layout.tsx. This one does: when requireOrgAccess cannot read the
 * membership check (AccessUnreadableError, ADR 0030 section F), the person
 * sees the "try again" panel inside the root layout, with no organisation
 * data. A redirect from the guard is not an error and passes through.
 */
export default function OrgError(props: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return <RouteError {...props} />;
}

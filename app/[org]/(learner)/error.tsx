"use client";

import { RouteError } from "@/components/ui/route-error";

export default function LearnerError(props: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return <RouteError {...props} />;
}

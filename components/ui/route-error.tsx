"use client";

import { startTransition } from "react";
import { useRouter } from "next/navigation";
import { AlertTriangle } from "lucide-react";
import { Button } from "./button";

/**
 * Friendly route-level error fallback (used by error.tsx boundaries). Replaces
 * the default white-screen crash with a branded message + retry. We
 * deliberately do NOT surface the raw error to users; details go to Sentry.
 *
 * "Try again" asks the server again, then resets the boundary, in one
 * transition. reset() alone only draws the segment again from the result the
 * browser already holds, so an error thrown on the server (a layout's or a
 * page's) came back unchanged and the server was never asked (ADR 0030, note
 * "Pull request B build decisions", change 1).
 */
export function RouteError({ reset }: { error: Error; reset: () => void }) {
  const router = useRouter();
  const retry = () =>
    startTransition(() => {
      router.refresh();
      reset();
    });
  return (
    <div className="min-h-[50vh] flex items-center justify-center p-6">
      <div className="max-w-md text-center">
        <span className="mx-auto mb-4 inline-flex rounded-full bg-red-100 p-3">
          <AlertTriangle className="w-6 h-6 text-red-600" />
        </span>
        <h2 className="serif text-xl text-ink">Something went wrong</h2>
        <p className="mt-2 text-sm text-muted leading-relaxed">
          We hit an unexpected error loading this page. Please try again — if it
          keeps happening, contact support.
        </p>
        <div className="mt-5 flex justify-center">
          <Button onClick={retry}>Try again</Button>
        </div>
      </div>
    </div>
  );
}

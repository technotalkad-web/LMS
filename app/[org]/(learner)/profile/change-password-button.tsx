"use client";

import { Lock } from "lucide-react";

/**
 * Tiny client wrapper so the profile page (which is a React Server
 * Component because it needs requireOrgAccess + service-role DB reads)
 * can render a "Change password" button with an onClick handler without
 * violating the RSC "no functions across the server/client boundary"
 * rule. Without this split, Next throws at runtime:
 *
 *   Error: Event handlers cannot be passed to Client Component props.
 *
 * Caught via `wrangler tail` on staging while QAing /[org]/profile.
 *
 * TODO (post-launch): once a proper /[org]/change-password page exists
 * (the authenticated equivalent of /forgot-password — no email-entry
 * step needed since the user is already signed in), replace this
 * placeholder button with a real <Link href={`/${orgSlug}/change-password`}>
 * and delete this file.
 */
export function ChangePasswordButton() {
  return (
    <button
      type="button"
      onClick={() => {
        alert(
          "To change your password, sign out and use the 'Forgot password?' link on the login page, or ask an admin to reset it for you."
        );
      }}
      className="w-full inline-flex items-center justify-center gap-2 bg-canvas hover:bg-canvas/70 text-ink border border-line py-2.5 rounded-lg font-medium text-sm transition-colors"
    >
      <Lock className="w-4 h-4" />
      Change password
    </button>
  );
}

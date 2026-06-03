"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";

/**
 * Parses the URL fragment for Supabase Auth tokens or errors.
 *
 * Two shapes Supabase returns:
 *   Success (implicit flow):
 *     #access_token=...&refresh_token=...&expires_in=...&token_type=bearer&type=magiclink
 *   Failure:
 *     #error=access_denied&error_code=otp_expired&error_description=...
 *
 * The fragment is browser-only — server route handlers can't read it,
 * which is why /auth/callback/route.ts can't handle these on its own.
 * This client component bridges the gap.
 */
type FragmentState =
  | { kind: "idle" }
  | { kind: "completing" }
  | { kind: "error"; code: string; description: string }
  | { kind: "noop" };

export function AuthCallbackFragment() {
  const [state, setState] = useState<FragmentState>({ kind: "idle" });

  useEffect(() => {
    if (typeof window === "undefined") return;
    const hash = window.location.hash;
    if (!hash || hash.length < 2) {
      setState({ kind: "noop" });
      return;
    }
    const params = new URLSearchParams(hash.slice(1));

    const errorCode = params.get("error_code") ?? params.get("error");
    if (errorCode) {
      const description =
        params.get("error_description")?.replace(/\+/g, " ") ??
        "The sign-in link is no longer valid.";
      setState({ kind: "error", code: errorCode, description });
      return;
    }

    const access_token = params.get("access_token");
    const refresh_token = params.get("refresh_token");
    if (access_token && refresh_token) {
      setState({ kind: "completing" });
      const supabase = createClient();
      supabase.auth
        .setSession({ access_token, refresh_token })
        .then(({ error }) => {
          if (error) {
            setState({
              kind: "error",
              code: "setSession_failed",
              description: error.message,
            });
            return;
          }
          // Land in the app. Full nav so server gates re-read cookies.
          window.location.replace("/select-org");
        })
        .catch((e: unknown) => {
          setState({
            kind: "error",
            code: "setSession_threw",
            description: e instanceof Error ? e.message : String(e),
          });
        });
      return;
    }

    setState({ kind: "noop" });
  }, []);

  if (state.kind === "idle" || state.kind === "completing") {
    return (
      <div className="min-h-screen flex items-center justify-center bg-canvas">
        <div className="text-center">
          <div className="inline-block w-8 h-8 border-2 border-indigo-600 border-t-transparent rounded-full animate-spin mb-4" />
          <p className="text-muted text-sm">
            {state.kind === "completing"
              ? "Signing you in…"
              : "Checking your sign-in link…"}
          </p>
        </div>
      </div>
    );
  }

  if (state.kind === "noop") {
    // No hash payload and no query payload — user landed here directly
    // or the server already redirected with ?error. Send them back to
    // /login so they can try again. (If the page reached here with
    // ?error=..., the server-rendered LoginRedirect below handles it.)
    if (typeof window !== "undefined") {
      window.location.replace("/login");
    }
    return null;
  }

  // state.kind === "error"
  const friendly = friendlyMessage(state.code);

  return (
    <div className="min-h-screen flex items-center justify-center bg-canvas px-6">
      <div className="max-w-md w-full bg-paper border border-line rounded-2xl p-8 shadow-sm">
        <div className="w-12 h-12 mx-auto rounded-full bg-red-100 flex items-center justify-center mb-5">
          <svg
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="w-6 h-6 text-red-600"
            aria-hidden="true"
          >
            <circle cx="12" cy="12" r="10" />
            <line x1="12" y1="8" x2="12" y2="12" />
            <line x1="12" y1="16" x2="12.01" y2="16" />
          </svg>
        </div>
        <h1 className="serif text-2xl text-center mb-2">{friendly.title}</h1>
        <p className="text-muted text-sm text-center mb-6">{friendly.body}</p>
        <div className="space-y-3">
          <Link
            href="/login"
            className="block w-full text-center bg-ink text-canvas font-semibold rounded-lg py-2.5 hover:opacity-90 transition"
          >
            Request a new sign-in link
          </Link>
          <details className="text-xs text-muted">
            <summary className="cursor-pointer text-center">
              Technical details
            </summary>
            <pre className="mt-2 p-3 bg-canvas border border-line rounded text-[11px] overflow-x-auto whitespace-pre-wrap break-words">
              code: {state.code}
              {"\n"}
              description: {state.description}
            </pre>
          </details>
        </div>
      </div>
    </div>
  );
}

function friendlyMessage(code: string): { title: string; body: string } {
  switch (code) {
    case "otp_expired":
      return {
        title: "This sign-in link has expired",
        body: "Magic links expire about an hour after being sent, and can only be used once. Request a fresh link below — it should work right away.",
      };
    case "access_denied":
      return {
        title: "This sign-in link is no longer valid",
        body: "It may have already been used, or a newer link was requested for the same email (which invalidates older ones). Request a fresh link below.",
      };
    case "setSession_failed":
    case "setSession_threw":
      return {
        title: "We couldn’t finish signing you in",
        body: "Your link was valid but something went wrong setting up your session. Request a fresh link and try again — if it keeps failing, contact support.",
      };
    default:
      return {
        title: "This sign-in link didn’t work",
        body: "Something went wrong verifying your link. Request a fresh one below.",
      };
  }
}

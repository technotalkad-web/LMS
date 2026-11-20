import type { Metadata } from "next";
import { SetPasswordForm } from "./set-password-form";

/**
 * "Set your password" (ADR 0029, rule N9): where a setup link opens,
 * /auth/set-password#t=<token>.
 *
 * The page is the same for every visitor and reads nothing on the server:
 * the token is in the link's fragment, which a browser never sends. The
 * form reads it in the browser, takes it out of the address bar, and posts
 * it to /api/auth/set-password, first alone (a read that spends nothing),
 * then with the new password. It loads nothing from another site and sends
 * no referrer (the meta tag here and the middleware's header).
 */
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Set your password",
  referrer: "no-referrer",
  robots: { index: false, follow: false },
};

export default function SetPasswordPage() {
  return (
    <main className="min-h-screen bg-canvas flex items-center justify-center px-4 py-12">
      <div className="w-full max-w-md">
        <SetPasswordForm />
      </div>
    </main>
  );
}

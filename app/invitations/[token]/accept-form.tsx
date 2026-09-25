"use client";

import { useState } from "react";
import { FullScreenLoader, handOff, usePreloadBrandLoader } from "@/components/ui/brand-loader";

export function AcceptForm({ token, email }: { token: string; email: string }) {
  const [password, setPassword] = useState("");
  const [status, setStatus] = useState<"idle" | "working" | "redirecting" | "error">("idle");
  const [error, setError] = useState<string | null>(null);
  usePreloadBrandLoader();

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setStatus("working");
    setError(null);

    const res = await fetch("/api/invitations/accept", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token, password }),
    });
    const json = (await res.json().catch(() => ({}))) as {
      ok?: boolean;
      error?: string;
      message?: string;
      needsManualSignIn?: boolean;
    };

    if (!res.ok || !json.ok) {
      setError(json.error ?? "Could not accept invitation");
      setStatus("error");
      return;
    }
    const target = json.needsManualSignIn
      ? "/login?msg=" + encodeURIComponent(json.message ?? "")
      : "/select-org";
    handOff(target, () => setStatus("redirecting"));
  }

  return (
    <form onSubmit={onSubmit} className="space-y-3">
      {status === "redirecting" && <FullScreenLoader message="Setting up your account…" delayed={false} />}
      <input
        type="email"
        value={email}
        disabled
        className="w-full px-4 py-3 border border-line rounded-lg bg-canvas text-muted outline-none"
      />
      <input
        type="password"
        required
        autoFocus
        minLength={6}
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        placeholder="Choose a password (6+ chars)"
        className="w-full px-4 py-3 border border-line rounded-lg bg-paper outline-none focus:border-ink transition-colors"
      />
      <button
        type="submit"
        disabled={status === "working"}
        className="w-full px-4 py-3 bg-ink text-canvas rounded-lg font-medium hover:opacity-90 disabled:opacity-50 transition-opacity"
      >
        {status === "working" ? "Working..." : "Accept invitation"}
      </button>
      {error && <p className="text-sm text-red-700 pt-1">{error}</p>}
      <p className="text-xs text-muted">
        If you already have an account with this email, enter your existing
        password.
      </p>
    </form>
  );
}

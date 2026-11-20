"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Eye, EyeOff, Lock, CheckCircle2 } from "lucide-react";

/**
 * The browser half of the set-password page (ADR 0029, rule N9). It reads
 * the token from the fragment once, removes the fragment from the address
 * bar, and keeps the token in memory only. The first post carries the token
 * alone: the route answers with the organisation's name and the password
 * rule, or with the one answer for a link that cannot be used. The second
 * carries the new password too.
 */
type View =
  | { kind: "loading" }
  | { kind: "form"; organization: string; rule: string }
  | { kind: "message"; text: string; signIn: string | null }
  | { kind: "done"; next: string };

const FALLBACK = "Something went wrong. Try again in a moment.";

function tokenFromFragment(): string | null {
  const hash = window.location.hash;
  if (!hash || hash.length < 2) return null;
  return new URLSearchParams(hash.slice(1)).get("t");
}

export function SetPasswordForm() {
  const token = useRef<string | null>(null);
  const [view, setView] = useState<View>({ kind: "loading" });
  const [pw, setPw] = useState("");
  const [confirm, setConfirm] = useState("");
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (token.current === null) token.current = tokenFromFragment();
    // The token leaves the address bar and the history entry at once.
    if (window.location.hash) {
      window.history.replaceState(null, "", window.location.pathname + window.location.search);
    }
    let cancelled = false;
    (async () => {
      const res = await fetch("/api/auth/set-password", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token: token.current ?? "" }),
        referrerPolicy: "no-referrer",
      }).catch(() => null);
      const j = (await res?.json().catch(() => ({}))) as { organization?: string; rule?: string; error?: string } | undefined;
      if (cancelled) return;
      if (res?.ok && j?.organization) {
        setView({ kind: "form", organization: j.organization, rule: j.rule ?? "" });
      } else {
        setView({ kind: "message", text: j?.error ?? FALLBACK, signIn: null });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    if (pw !== confirm) {
      setErr("The two passwords do not match.");
      return;
    }
    setBusy(true);
    const res = await fetch("/api/auth/set-password", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: token.current ?? "", password: pw }),
      referrerPolicy: "no-referrer",
    }).catch(() => null);
    setBusy(false);
    const j = (await res?.json().catch(() => ({}))) as { next?: string; error?: string; code?: string } | undefined;
    if (res?.ok && j?.next) {
      setPw("");
      setConfirm("");
      setView({ kind: "done", next: j.next });
      return;
    }
    // The policy and a refused password keep the form: the link still works.
    if (j?.code === "policy" || j?.code === "refused") {
      setErr(j.error ?? FALLBACK);
      return;
    }
    setPw("");
    setConfirm("");
    setView({ kind: "message", text: j?.error ?? FALLBACK, signIn: j?.code === "not_confirmed" ? "/login" : null });
  }

  if (view.kind === "loading") {
    return (
      <div className="bg-paper border border-line rounded-lg p-6 text-center text-sm text-muted">Checking your link…</div>
    );
  }

  if (view.kind === "message") {
    return (
      <div className="bg-paper border border-line rounded-lg p-6 space-y-4 text-center">
        <p className="text-sm">{view.text}</p>
        <div className="flex justify-center gap-4 text-sm">
          {view.signIn && (
            <Link href={view.signIn} className="underline">
              Sign in
            </Link>
          )}
          <Link href="/forgot-password" className="underline">
            Forgot password
          </Link>
        </div>
      </div>
    );
  }

  if (view.kind === "done") {
    return (
      <div className="bg-paper border border-line rounded-lg p-6 text-center space-y-3">
        <CheckCircle2 className="w-10 h-10 text-emerald-500 mx-auto" />
        <p className="serif text-2xl">Your password is set</p>
        <p className="text-muted text-sm">Sign in with your email address and the password you just chose.</p>
        <Link href={view.next} className="inline-block bg-ink text-canvas px-5 py-2 rounded-lg font-medium hover:opacity-90">
          Go to sign in
        </Link>
      </div>
    );
  }

  return (
    <div>
      <header className="text-center mb-8">
        <h1 className="serif text-4xl mb-2">Set your password</h1>
        <p className="text-muted text-sm">
          Choose the password for your account with <span className="font-semibold">{view.organization}</span>.
        </p>
      </header>
      <form onSubmit={submit} className="bg-paper border border-line rounded-lg p-6 space-y-4">
        <div>
          <label htmlFor="set-password-new" className="block text-sm font-semibold mb-1">
            New password
          </label>
          <div className="relative">
            <Lock className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted" />
            <input
              id="set-password-new"
              type={show ? "text" : "password"}
              value={pw}
              onChange={(e) => setPw(e.target.value)}
              required
              minLength={10}
              autoFocus
              autoComplete="new-password"
              className="w-full pl-9 pr-10 py-2 border border-line rounded-md text-sm bg-canvas"
            />
            <button
              type="button"
              onClick={() => setShow((v) => !v)}
              className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-muted hover:text-ink"
              aria-label={show ? "Hide password" : "Show password"}
            >
              {show ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
            </button>
          </div>
          {view.rule && <p className="text-xs text-muted mt-1">{view.rule}</p>}
        </div>
        <div>
          <label htmlFor="set-password-confirm" className="block text-sm font-semibold mb-1">
            Confirm password
          </label>
          <input
            id="set-password-confirm"
            type={show ? "text" : "password"}
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            required
            minLength={10}
            autoComplete="new-password"
            className="w-full px-3 py-2 border border-line rounded-md text-sm bg-canvas"
          />
        </div>
        {err && <div className="border border-red-200 bg-red-50 text-red-900 rounded-lg p-3 text-sm">{err}</div>}
        <button
          type="submit"
          disabled={busy || pw.length === 0 || confirm.length === 0}
          className="w-full bg-ink text-canvas py-2 rounded-lg font-medium hover:opacity-90 disabled:opacity-50"
        >
          {busy ? "Saving…" : "Set password"}
        </button>
      </form>
    </div>
  );
}

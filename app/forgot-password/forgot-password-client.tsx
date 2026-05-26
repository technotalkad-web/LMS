"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  ArrowLeft,
  ArrowRight,
  CheckCircle2,
  Eye,
  EyeOff,
  Lock,
  Mail,
  ShieldCheck,
} from "lucide-react";
import { createClient } from "@/lib/supabase/client";

type Step = "request" | "verify" | "reset" | "signing_in";

/**
 * Single-page password-recovery flow:
 *
 *   Email entry → 6-digit code (auto-submit on 6th digit)
 *               → new/confirm password
 *               → silent sign-in
 *               → redirect to /select-org (which routes to dashboard)
 *
 * No full-page reloads between steps. Errors render inline.
 */
export function ForgotPasswordClient() {
  const router = useRouter();
  const supabase = createClient();

  const [step, setStep] = useState<Step>("request");
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [resetToken, setResetToken] = useState("");
  const [pw, setPw] = useState("");
  const [pw2, setPw2] = useState("");
  const [showPw, setShowPw] = useState(false);

  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  /* ---------- step 1: request code ---------- */
  async function submitRequest(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    setInfo(null);
    try {
      const res = await fetch("/api/auth/forgot-password/request", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: email.trim() }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) {
        setErr(j.error ?? "Could not send code");
        setBusy(false);
        return;
      }
      setStep("verify");
      setInfo(`We sent a 6-digit code to ${email.trim()}.`);
    } finally {
      setBusy(false);
    }
  }

  /* ---------- step 2: auto-verify on 6th digit ---------- */
  const verifyInputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (step === "verify") {
      // Brief delay so the input is in the DOM.
      const t = setTimeout(() => verifyInputRef.current?.focus(), 60);
      return () => clearTimeout(t);
    }
  }, [step]);

  async function verifyCode(c: string) {
    if (c.length !== 6 || busy) return;
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch("/api/auth/forgot-password/verify", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: email.trim(), code: c }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) {
        setErr(j.error ?? "Verification failed");
        return;
      }
      setResetToken(j.reset_token as string);
      setStep("reset");
      setInfo("Code verified. Choose a new password.");
    } finally {
      setBusy(false);
    }
  }

  function onCodeChange(v: string) {
    const clean = v.replace(/\D/g, "").slice(0, 6);
    setCode(clean);
    setErr(null);
    if (clean.length === 6) {
      // Auto-submit per UX spec.
      void verifyCode(clean);
    }
  }

  /* ---------- step 3: set new password, step 4: auto-login ---------- */
  async function submitReset(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    if (pw !== pw2) {
      setErr("Passwords don't match.");
      return;
    }
    setBusy(true);
    try {
      const res = await fetch("/api/auth/forgot-password/reset", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          email: email.trim(),
          reset_token: resetToken,
          new_password: pw,
        }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) {
        setErr(j.error ?? "Could not save new password");
        setBusy(false);
        return;
      }
      // Silent sign-in with the password we just set. No tab switch,
      // no re-typing — straight to dashboard.
      setStep("signing_in");
      const { error: signinErr } = await supabase.auth.signInWithPassword({
        email: email.trim(),
        password: pw,
      });
      if (signinErr) {
        // Fallback: send them to /login with a friendly note.
        setErr(
          `Password updated, but we couldn't sign you in automatically: ${signinErr.message}. Please sign in manually.`
        );
        setStep("reset");
        setBusy(false);
        return;
      }
      // Full nav so server gates re-evaluate with the new cookies.
      window.location.href = "/select-org";
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Network error");
      setBusy(false);
    }
  }

  /* ---------- step 2b: resend code ---------- */
  async function resend() {
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch("/api/auth/forgot-password/request", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: email.trim() }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) {
        setErr(j.error ?? "Could not send code");
      } else {
        setInfo(`We sent a new code to ${email.trim()}.`);
        setCode("");
      }
    } finally {
      setBusy(false);
    }
  }

  /* ---------- render ---------- */
  return (
    <div className="bg-paper border border-line rounded-xl p-7 shadow-sm">
      <header className="text-center mb-6">
        <div className="w-10 h-10 mx-auto mb-3 rounded-full bg-indigo-50 text-indigo-700 flex items-center justify-center">
          {step === "request" ? <Mail className="w-5 h-5" /> :
            step === "verify" ? <ShieldCheck className="w-5 h-5" /> :
            <Lock className="w-5 h-5" />}
        </div>
        <h1 className="serif text-3xl tracking-tight">
          {step === "request" && "Forgot your password?"}
          {step === "verify" && "Enter the 6-digit code"}
          {(step === "reset" || step === "signing_in") && "Set a new password"}
        </h1>
        <p className="text-muted text-sm mt-1">
          {step === "request" && "We'll email you a single-use code."}
          {step === "verify" && info}
          {step === "reset" && info}
          {step === "signing_in" && "Signing you in…"}
        </p>
      </header>

      {/* Step 1: email */}
      {step === "request" && (
        <form onSubmit={submitRequest} className="space-y-4">
          <label className="block">
            <span className="text-xs font-semibold text-muted uppercase tracking-wider">
              Email address
            </span>
            <div className="relative mt-1">
              <Mail className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted" />
              <input
                type="email"
                required
                autoFocus
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="w-full pl-9 pr-3 py-2.5 border border-line rounded-md text-sm bg-canvas"
                placeholder="you@company.com"
              />
            </div>
          </label>

          {err && <ErrorBox>{err}</ErrorBox>}

          <button
            type="submit"
            disabled={busy || !email.trim()}
            className="w-full bg-indigo-600 hover:bg-indigo-700 disabled:opacity-60 text-white font-semibold rounded-md py-2.5 transition flex items-center justify-center gap-2"
          >
            {busy ? "Sending…" : "Send code"}
            {!busy && <ArrowRight className="w-4 h-4" />}
          </button>

          <p className="text-center text-sm text-muted pt-2">
            <Link href="/login" className="hover:text-ink inline-flex items-center gap-1">
              <ArrowLeft className="w-3 h-3" /> Back to sign in
            </Link>
          </p>
        </form>
      )}

      {/* Step 2: code */}
      {step === "verify" && (
        <div className="space-y-4">
          <input
            ref={verifyInputRef}
            type="text"
            inputMode="numeric"
            autoComplete="one-time-code"
            value={code}
            onChange={(e) => onCodeChange(e.target.value)}
            disabled={busy}
            placeholder="000000"
            className="w-full text-center text-3xl tracking-[0.6em] font-mono py-4 border border-line rounded-md bg-canvas outline-none focus:border-indigo-500 disabled:opacity-60"
            maxLength={6}
          />

          {err && <ErrorBox>{err}</ErrorBox>}

          {busy && (
            <p className="text-center text-sm text-muted flex items-center justify-center gap-2">
              <span className="w-3 h-3 border-2 border-indigo-500 border-t-transparent rounded-full animate-spin" />
              Verifying…
            </p>
          )}

          <div className="flex items-center justify-between text-xs text-muted pt-2">
            <button
              type="button"
              onClick={() => {
                setStep("request");
                setCode("");
                setErr(null);
                setInfo(null);
              }}
              className="hover:text-ink inline-flex items-center gap-1"
            >
              <ArrowLeft className="w-3 h-3" /> Wrong email?
            </button>
            <button
              type="button"
              onClick={resend}
              disabled={busy}
              className="hover:text-ink disabled:opacity-60"
            >
              Resend code
            </button>
          </div>
        </div>
      )}

      {/* Step 3: new password */}
      {(step === "reset" || step === "signing_in") && (
        <form onSubmit={submitReset} className="space-y-4">
          <label className="block">
            <span className="text-xs font-semibold text-muted uppercase tracking-wider">
              New password
            </span>
            <div className="relative mt-1">
              <Lock className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted" />
              <input
                type={showPw ? "text" : "password"}
                required
                minLength={10}
                autoFocus
                value={pw}
                onChange={(e) => setPw(e.target.value)}
                disabled={busy || step === "signing_in"}
                className="w-full pl-9 pr-9 py-2.5 border border-line rounded-md text-sm bg-canvas"
                placeholder="Minimum 10 characters"
              />
              <button
                type="button"
                tabIndex={-1}
                onClick={() => setShowPw((v) => !v)}
                className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-muted hover:text-ink"
              >
                {showPw ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
              </button>
            </div>
          </label>

          <label className="block">
            <span className="text-xs font-semibold text-muted uppercase tracking-wider">
              Confirm new password
            </span>
            <div className="relative mt-1">
              <Lock className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted" />
              <input
                type={showPw ? "text" : "password"}
                required
                value={pw2}
                onChange={(e) => setPw2(e.target.value)}
                disabled={busy || step === "signing_in"}
                className="w-full pl-9 pr-3 py-2.5 border border-line rounded-md text-sm bg-canvas"
                placeholder="Repeat your new password"
              />
            </div>
            {pw2.length > 0 && pw !== pw2 && (
              <p className="text-xs text-red-600 mt-1">Passwords don&apos;t match.</p>
            )}
          </label>

          {err && <ErrorBox>{err}</ErrorBox>}

          <button
            type="submit"
            disabled={busy || step === "signing_in" || pw.length < 10 || pw !== pw2}
            className="w-full bg-indigo-600 hover:bg-indigo-700 disabled:opacity-60 text-white font-semibold rounded-md py-2.5 transition flex items-center justify-center gap-2"
          >
            {step === "signing_in" ? (
              <>
                <span className="w-3 h-3 border-2 border-white border-t-transparent rounded-full animate-spin" />
                Signing you in…
              </>
            ) : busy ? (
              "Saving…"
            ) : (
              <>
                <CheckCircle2 className="w-4 h-4" /> Save password
              </>
            )}
          </button>
        </form>
      )}
    </div>
  );
}

function ErrorBox({ children }: { children: React.ReactNode }) {
  return (
    <div className="bg-red-50 border border-red-200 text-red-800 text-sm rounded-md p-3">
      {children}
    </div>
  );
}

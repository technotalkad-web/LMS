"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import {
  ArrowRight,
  BookOpen,
  CheckCircle2,
  Lock,
  Mail,
  ShieldCheck,
  Sparkles,
} from "lucide-react";

type Mode = "password" | "magic";

export default function LoginPage() {
  const [mode, setMode] = useState<Mode>("password");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [status, setStatus] = useState<
    "idle" | "working" | "sent" | "error"
  >("idle");
  const [error, setError] = useState<string | null>(null);
  // Render the form client-only so password-manager extensions
  // (LastPass, 1Password, Chrome autofill) can't inject autocomplete
  // attributes between SSR and hydrate and trigger a mismatch warning.
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  function switchMode(next: Mode) {
    setMode(next);
    setStatus("idle");
    setError(null);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setStatus("working");
    setError(null);

    const supabase = createClient();
    if (mode === "magic") {
      const { error } = await supabase.auth.signInWithOtp({
        email,
        options: {
          emailRedirectTo: `${window.location.origin}/auth/callback`,
        },
      });
      if (error) {
        setError(error.message);
        setStatus("error");
      } else {
        setStatus("sent");
      }
    } else {
      const { error } = await supabase.auth.signInWithPassword({
        email,
        password,
      });
      if (error) {
        setError(error.message);
        setStatus("error");
      } else {
        // Full page nav so the server reads the new cookies.
        window.location.href = "/select-org";
      }
    }
  }

  return (
    <div className="min-h-screen flex bg-canvas">
      {/* ====== Left panel: branding ============================ */}
      <aside className="hidden lg:flex lg:w-1/2 relative overflow-hidden flex-col justify-between p-12 text-white">
        {/* Dark base */}
        <div className="absolute inset-0 z-0 bg-slate-900" aria-hidden />

        {/* Layered gradient + decorative pattern */}
        <div
          className="absolute inset-0 z-0 bg-gradient-to-br from-slate-900 via-slate-900 to-indigo-950"
          aria-hidden
        />
        <div
          className="absolute inset-0 z-0 opacity-[0.07] pointer-events-none"
          aria-hidden
        >
          <BookOpen
            className="absolute -top-32 -left-32 w-[640px] h-[640px] text-indigo-300 -rotate-12"
            strokeWidth={0.7}
          />
        </div>
        {/* Soft glow */}
        <div
          className="absolute -bottom-40 -right-20 w-[600px] h-[600px] rounded-full bg-indigo-600/20 blur-3xl z-0 pointer-events-none"
          aria-hidden
        />

        {/* Top: logo */}
        <div className="relative z-10">
          <div className="flex items-center gap-3">
            <div className="w-11 h-11 bg-indigo-600 rounded-2xl flex items-center justify-center shadow-lg shadow-indigo-900/40">
              <BookOpen className="text-white w-6 h-6" />
            </div>
            <span className="font-semibold text-2xl tracking-tight">LMS</span>
          </div>
        </div>

        {/* Middle: marketing copy */}
        <div className="relative z-10 max-w-lg">
          <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-white/10 backdrop-blur-sm text-xs font-medium text-indigo-200 mb-6">
            <Sparkles className="w-3.5 h-3.5" /> Continuous learning, simplified
          </div>
          <h1 className="text-4xl xl:text-5xl font-semibold leading-[1.1] tracking-tight mb-5">
            Build the skills your team needs to ship faster.
          </h1>
          <p className="text-slate-300 text-lg leading-relaxed mb-10 max-w-md">
            Assign courses, track completions, and keep learners on the path
            with a clean, professional experience.
          </p>

          <ul className="space-y-3 text-sm text-slate-200">
            <FeatureLine>SCORM 1.2 + cmi5 packages out of the box</FeatureLine>
            <FeatureLine>Learning paths with prereq locks</FeatureLine>
            <FeatureLine>Granular RBAC + per-org SMTP</FeatureLine>
          </ul>
        </div>

        {/* Bottom: trust badge */}
        <div className="relative z-10 flex items-center gap-3 text-sm text-slate-300">
          <div className="flex items-center gap-2 bg-white/5 px-3 py-1.5 rounded-full backdrop-blur-sm border border-white/10">
            <ShieldCheck className="w-4 h-4 text-emerald-400" />
            <span>Enterprise-secure auth</span>
          </div>
        </div>
      </aside>

      {/* ====== Right panel: form ============================== */}
      <main className="w-full lg:w-1/2 flex items-center justify-center p-6 sm:p-10 lg:p-16">
        <div className="w-full max-w-md">
          {/* Mobile logo */}
          <div className="flex lg:hidden items-center gap-2.5 mb-10">
            <div className="w-10 h-10 bg-ink text-canvas rounded-xl flex items-center justify-center shadow-md">
              <BookOpen className="w-5 h-5" />
            </div>
            <span className="serif text-2xl tracking-tight">LMS</span>
          </div>

          <div className="mb-8">
            <h2 className="serif text-4xl tracking-tight mb-2">Welcome back</h2>
            <p className="text-muted text-sm">
              Sign in to continue your learning journey.
            </p>
          </div>

          {/* Toggle */}
          <div
            role="tablist"
            className="flex p-1 bg-paper border border-line rounded-xl mb-7"
          >
            <button
              role="tab"
              aria-selected={mode === "password"}
              type="button"
              onClick={() => switchMode("password")}
              className={`flex-1 py-2 text-sm font-medium rounded-lg transition-all ${
                mode === "password"
                  ? "bg-ink text-canvas shadow-sm"
                  : "text-muted hover:text-ink"
              }`}
            >
              Password
            </button>
            <button
              role="tab"
              aria-selected={mode === "magic"}
              type="button"
              onClick={() => switchMode("magic")}
              className={`flex-1 py-2 text-sm font-medium rounded-lg transition-all ${
                mode === "magic"
                  ? "bg-ink text-canvas shadow-sm"
                  : "text-muted hover:text-ink"
              }`}
            >
              Magic link
            </button>
          </div>

          {/* Sent state */}
          {status === "sent" ? (
            <div className="border border-emerald-200 bg-emerald-50 text-emerald-900 rounded-2xl p-5 flex items-start gap-3">
              <CheckCircle2 className="w-5 h-5 text-emerald-600 shrink-0 mt-0.5" />
              <div>
                <h3 className="font-semibold mb-1">Check your inbox</h3>
                <p className="text-sm text-emerald-800/90">
                  We sent a sign-in link to{" "}
                  <span className="font-medium">{email}</span>. Tap it from any
                  device to finish signing in.
                </p>
                <button
                  type="button"
                  onClick={() => switchMode("magic")}
                  className="mt-3 text-xs underline hover:text-emerald-700"
                >
                  Use a different email
                </button>
              </div>
            </div>
          ) : !mounted ? (
            // Pre-hydration skeleton — avoids autofill-extension hydration warning.
            <div className="space-y-4">
              <div className="h-[68px] border border-line rounded-xl bg-paper animate-pulse" />
              <div className="h-[68px] border border-line rounded-xl bg-paper animate-pulse" />
              <div className="h-[52px] border border-line rounded-xl bg-paper animate-pulse" />
            </div>
          ) : (
            <form onSubmit={handleSubmit} className="space-y-4">
              <div className="space-y-1.5">
                <label
                  htmlFor="email"
                  className="text-sm font-medium text-ink"
                >
                  Work email
                </label>
                <div className="relative">
                  <Mail className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-muted pointer-events-none" />
                  <input
                    id="email"
                    type="email"
                    required
                    autoFocus
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="you@company.com"
                    className="w-full pl-10 pr-4 py-3 text-sm border border-line rounded-xl bg-paper outline-none focus:border-ink focus:ring-2 focus:ring-ink/10 transition-all"
                  />
                </div>
              </div>

              {mode === "password" && (
                <div className="space-y-1.5">
                  <div className="flex justify-between items-center">
                    <label
                      htmlFor="password"
                      className="text-sm font-medium text-ink"
                    >
                      Password
                    </label>
                    <Link
                      href="/forgot-password"
                      className="text-xs text-muted hover:text-ink underline-offset-4 hover:underline"
                    >
                      Forgot password?
                    </Link>
                  </div>
                  <div className="relative">
                    <Lock className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-muted pointer-events-none" />
                    <input
                      id="password"
                      type="password"
                      required
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      placeholder="••••••••"
                      className="w-full pl-10 pr-4 py-3 text-sm border border-line rounded-xl bg-paper outline-none focus:border-ink focus:ring-2 focus:ring-ink/10 transition-all"
                    />
                  </div>
                </div>
              )}

              {mode === "magic" && (
                <p className="text-xs text-muted">
                  We&apos;ll email you a one-tap link to sign in — no password
                  needed.
                </p>
              )}

              <button
                type="submit"
                disabled={status === "working"}
                className="w-full mt-2 px-4 py-3 bg-ink text-canvas rounded-xl text-sm font-semibold hover:opacity-90 disabled:opacity-50 transition-opacity flex items-center justify-center gap-2 shadow-sm"
              >
                {status === "working"
                  ? "Working…"
                  : mode === "magic"
                    ? "Send magic link"
                    : "Sign in"}
                {status !== "working" && <ArrowRight className="w-4 h-4" />}
              </button>

              {error && (
                <div className="border border-red-200 bg-red-50 text-red-900 rounded-xl px-4 py-3 text-sm">
                  {error}
                </div>
              )}
            </form>
          )}

          <p className="text-center text-xs text-muted mt-10">
            By signing in you agree to our{" "}
            <a href="#" className="underline hover:text-ink">
              Terms
            </a>{" "}
            and{" "}
            <a href="#" className="underline hover:text-ink">
              Privacy Policy
            </a>
            .
          </p>
        </div>
      </main>
    </div>
  );
}

function FeatureLine({ children }: { children: React.ReactNode }) {
  return (
    <li className="flex items-start gap-3">
      <span className="mt-1.5 inline-block w-1.5 h-1.5 rounded-full bg-indigo-400 shrink-0" />
      <span>{children}</span>
    </li>
  );
}

"use client";

import { useState } from "react";
import Link from "next/link";
import {
  ArrowRight,
  BookOpen,
  CheckCircle2,
  Lock,
  Mail,
  ShieldCheck,
  Sparkles,
} from "lucide-react";
import { createClient } from "@/lib/supabase/client";

export type BrandedLoginProps = {
  orgSlug: string;
  orgName: string;
  logoUrl: string | null;
  brandColor: string;
  heroImageUrl: string | null;
  heroTitle: string;
  heroSubtitle: string;
};

type Mode = "password" | "magic";

/**
 * Where to land after a successful password sign-in. Honors a host-relative
 * `next` (set by the middleware auth gate — e.g. a clean /dashboard on a
 * white-label domain), falling back to the tenant dashboard. Guards against
 * open redirects (must start with a single "/").
 */
function safeNext(orgSlug: string): string {
  if (typeof window === "undefined") return `/${orgSlug}/dashboard`;
  const n = new URLSearchParams(window.location.search).get("next");
  if (n && n.startsWith("/") && !n.startsWith("//")) return n;
  return `/${orgSlug}/dashboard`;
}

export function BrandedLogin({
  orgSlug,
  orgName,
  logoUrl,
  brandColor,
  heroImageUrl,
  heroTitle,
  heroSubtitle,
}: BrandedLoginProps) {
  const [mode, setMode] = useState<Mode>("password");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [status, setStatus] = useState<
    "idle" | "working" | "sent" | "error"
  >("idle");
  const [error, setError] = useState<string | null>(null);

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
          emailRedirectTo: `${window.location.origin}/auth/callback?next=/${orgSlug}/dashboard`,
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
        window.location.href = safeNext(orgSlug);
      }
    }
  }

  const LogoBlock = ({ size = "md" }: { size?: "md" | "lg" }) =>
    logoUrl ? (
      /* eslint-disable-next-line @next/next/no-img-element */
      <img
        src={logoUrl}
        alt={orgName}
        className={
          size === "lg"
            ? "h-12 w-auto max-w-[220px] object-contain"
            : "h-10 w-auto max-w-[180px] object-contain"
        }
      />
    ) : (
      <div
        className={`${
          size === "lg" ? "w-12 h-12" : "w-10 h-10"
        } rounded-2xl flex items-center justify-center shadow-lg`}
        style={{ background: brandColor }}
      >
        <BookOpen className="w-6 h-6 text-white" />
      </div>
    );

  return (
    <div className="min-h-screen flex bg-canvas">
      {/* Left: branded hero */}
      <aside className="hidden lg:flex lg:w-1/2 relative overflow-hidden flex-col justify-between p-12 text-white">
        <div className="absolute inset-0 z-0 bg-slate-900" aria-hidden />
        {heroImageUrl && (
          /* eslint-disable-next-line @next/next/no-img-element */
          <img
            src={heroImageUrl}
            alt=""
            className="absolute inset-0 z-0 w-full h-full object-cover"
          />
        )}
        <div
          className="absolute inset-0 z-0 bg-gradient-to-br from-slate-900/95 via-slate-900/80 to-slate-900/70"
          aria-hidden
        />
        <div
          className="absolute -bottom-40 -right-20 w-[600px] h-[600px] rounded-full blur-3xl z-0 pointer-events-none opacity-30"
          style={{ background: brandColor }}
          aria-hidden
        />

        <div className="relative z-10">
          <div className="flex items-center gap-3">
            <LogoBlock size="lg" />
            <span className="font-semibold text-2xl tracking-tight">
              {orgName}
            </span>
          </div>
        </div>

        <div className="relative z-10 max-w-lg">
          <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-white/10 backdrop-blur-sm text-xs font-medium mb-6">
            <Sparkles className="w-3.5 h-3.5" /> Continuous learning, simplified
          </div>
          <h1 className="text-4xl xl:text-5xl font-semibold leading-[1.1] tracking-tight mb-5">
            {heroTitle}
          </h1>
          <p className="text-slate-200/90 text-lg leading-relaxed mb-10 max-w-md">
            {heroSubtitle}
          </p>
        </div>

        <div className="relative z-10 flex items-center gap-3 text-sm text-slate-300">
          <div className="flex items-center gap-2 bg-white/5 px-3 py-1.5 rounded-full backdrop-blur-sm border border-white/10">
            <ShieldCheck className="w-4 h-4 text-emerald-400" />
            <span>Enterprise-secure auth</span>
          </div>
        </div>
      </aside>

      {/* Right: form */}
      <main className="w-full lg:w-1/2 flex items-center justify-center p-6 sm:p-10 lg:p-16">
        <div className="w-full max-w-md">
          <div className="flex lg:hidden items-center gap-3 mb-10">
            <LogoBlock />
            <span className="serif text-2xl tracking-tight">{orgName}</span>
          </div>

          <div className="mb-8">
            <h2 className="serif text-4xl tracking-tight mb-2">Welcome back</h2>
            <p className="text-muted text-sm">
              Sign in to {orgName} to continue your learning journey.
            </p>
          </div>

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

          {status === "sent" ? (
            <div className="border border-emerald-200 bg-emerald-50 text-emerald-900 rounded-2xl p-5 flex items-start gap-3">
              <CheckCircle2 className="w-5 h-5 text-emerald-600 shrink-0 mt-0.5" />
              <div>
                <h3 className="font-semibold mb-1">Check your inbox</h3>
                <p className="text-sm text-emerald-800/90">
                  We sent a sign-in link to{" "}
                  <span className="font-medium">{email}</span>.
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
          ) : (
            <form onSubmit={handleSubmit} className="space-y-4">
              <div className="space-y-1.5">
                <label htmlFor="email" className="text-sm font-medium text-ink">
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
                    placeholder={`you@${orgSlug}.com`}
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

              <button
                type="submit"
                disabled={status === "working"}
                className="w-full mt-2 px-4 py-3 rounded-xl text-sm font-semibold text-white hover:opacity-90 disabled:opacity-50 transition-opacity flex items-center justify-center gap-2 shadow-sm"
                style={{ background: brandColor }}
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
            By signing in you agree to {orgName}&apos;s Terms and Privacy
            Policy.
          </p>
        </div>
      </main>
    </div>
  );
}

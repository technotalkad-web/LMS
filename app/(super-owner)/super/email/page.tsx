import { createClient as createServiceClient } from "@supabase/supabase-js";
import { Mail } from "lucide-react";
import { requirePlatformOwner } from "@/lib/auth/require-platform-owner";
import { platformEmailHealthForRender } from "@/lib/email/platform-health";
import type { PlatformEmailReason } from "@/lib/ops/health-status";
import { SendTestButton } from "./send-test-button";

export const dynamic = "force-dynamic";

/**
 * /super/email: the platform sender (ADR 0029 sections F and H). Shows
 * whether the sender is configured (yes or no, and the names of missing
 * variables; never a value), its health reading, the last send's time,
 * kind, status and class, and the sent counts for 24 hours and 7 days
 * against the daily ceiling. "Send test" mails the signed-in owner's own
 * address. There is no form that stores the credential: it lives only in
 * the deployment's secrets (ops/RUNBOOK.md §6.3).
 *
 * The organisations' SMTP readings join this page with ADR 0029 pull
 * request B.
 */

const REASON_TEXT: Record<PlatformEmailReason, string> = {
  not_configured: "The sender is not configured: a required variable is missing or invalid.",
  log_unreadable: "The platform email log cannot be read (migration 0113 not pasted, or the database is unreachable). Nothing is sent without it.",
  sender_dead: "The newest send failed with an auth or quota error: the mailbox refuses to send until someone acts.",
  two_failures: "The two newest sends both failed.",
  last_failed: "The newest send failed (timeout, unreachable or unknown); the mail may still have arrived.",
  at_ceiling: "The daily ceiling is reached: only platform owners' own mail is sent until the 24-hour window moves.",
  half_ceiling: "Half of the daily ceiling is used.",
};

const STATUS_STYLE: Record<string, string> = {
  ok: "bg-emerald-100 text-emerald-800 border-emerald-200",
  warn: "bg-amber-100 text-amber-900 border-amber-200",
  fail: "bg-red-100 text-red-800 border-red-200",
};

const fmt = (iso: string | null | undefined) => (iso ? new Date(iso).toISOString().slice(0, 16).replace("T", " ") + " UTC" : "none");

export default async function PlatformEmailPage() {
  await requirePlatformOwner();
  const svc = createServiceClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } }
  );
  const weekAgo = new Date(Date.now() - 7 * 24 * 3_600_000).toISOString();
  const [health, lastRead, weekRead] = await Promise.all([
    // The layout's banner read the same reading in this render: shared, not repeated.
    platformEmailHealthForRender(),
    svc
      .from("platform_email_log")
      .select("sent_at, event_type, status, error_code")
      .order("sent_at", { ascending: false })
      .limit(1),
    svc
      .from("platform_email_log")
      .select("id", { count: "exact", head: true })
      .eq("status", "sent")
      .gte("sent_at", weekAgo),
  ]);
  const last = (Array.isArray(lastRead.data) ? lastRead.data[0] : null) as
    | { sent_at: string; event_type: string; status: string; error_code: string | null }
    | null
    | undefined;
  const sent7d = weekRead.error || typeof weekRead.count !== "number" ? null : weekRead.count;

  return (
    <div>
      <header className="mb-6">
        <h1 className="text-3xl font-bold tracking-tight text-ink flex items-center gap-3">
          <Mail className="w-7 h-7 text-accent" /> Platform Email
        </h1>
        <p className="text-muted mt-1">
          The platform&apos;s own mailbox: codes and sign-in links for platform owners and
          organisation administrators, administrator welcomes and SMTP alerts. It never sends
          a learner&apos;s mail, and no organisation&apos;s mail falls back to it.
        </p>
      </header>

      <section className="bg-paper border border-line rounded-xl shadow-sm p-6 mb-6">
        <div className="flex items-center gap-3 mb-4">
          <h2 className="text-lg font-semibold text-ink">Health</h2>
          <span className={`text-xs font-bold uppercase tracking-wider px-2 py-1 rounded border ${STATUS_STYLE[health.status] ?? ""}`}>
            {health.status}
          </span>
        </div>
        {health.reasons.length === 0 ? (
          <p className="text-sm text-muted">Configured, the log is readable and the newest send was delivered (or none was tried yet).</p>
        ) : (
          <ul className="list-disc pl-5 text-sm text-ink space-y-1">
            {health.reasons.map((r) => (
              <li key={r}>{REASON_TEXT[r]}</li>
            ))}
          </ul>
        )}
      </section>

      <section className="bg-paper border border-line rounded-xl shadow-sm p-6 mb-6">
        <h2 className="text-lg font-semibold text-ink mb-4">Sender</h2>
        <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-8 gap-y-3 text-sm">
          <dt className="text-muted">Configured</dt>
          <dd className="font-medium text-ink">{health.configured ? "Yes" : "No"}</dd>
          {!health.configured && (
            <>
              <dt className="text-muted">Missing or invalid</dt>
              <dd className="font-mono text-xs text-ink">{health.missing.join(", ")}</dd>
            </>
          )}
          <dt className="text-muted">Last send</dt>
          <dd className="text-ink">
            {last ? (
              <>
                {fmt(last.sent_at)} · <span className="font-mono text-xs">{last.event_type}</span> ·{" "}
                {last.status}
                {last.error_code ? ` (${last.error_code})` : ""}
              </>
            ) : lastRead.error ? (
              "unreadable"
            ) : (
              "none"
            )}
          </dd>
          <dt className="text-muted">Sent in 24 hours</dt>
          <dd className="text-ink">
            {health.sent24h === null ? "unreadable" : health.sent24h} of a ceiling of {health.ceiling}
          </dd>
          <dt className="text-muted">Sent in 7 days</dt>
          <dd className="text-ink">{sent7d === null ? "unreadable" : sent7d}</dd>
        </dl>
        <p className="text-xs text-muted mt-4">
          The settings live only in the deployment&apos;s secrets (the PLATFORM_SMTP_* and
          PLATFORM_EMAIL_* variables); this page never shows a value. Setup and rotation:
          ops/RUNBOOK.md §6.3.
        </p>
      </section>

      <section className="bg-paper border border-line rounded-xl shadow-sm p-6">
        <h2 className="text-lg font-semibold text-ink mb-2">Test</h2>
        <p className="text-sm text-muted mb-4">
          Sends the platform&apos;s fixed test message to your own account&apos;s address and
          records it in the audit log. Limited to 5 an hour and 10 a day that reach the mail
          server; a test that is not sent (not configured, or a domain outside the allow-list)
          is not counted.
        </p>
        <SendTestButton />
      </section>
    </div>
  );
}

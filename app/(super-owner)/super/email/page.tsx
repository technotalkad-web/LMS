import { createClient as createServiceClient } from "@supabase/supabase-js";
import { Mail } from "lucide-react";
import { requirePlatformOwner } from "@/lib/auth/require-platform-owner";
import { platformEmailHealthForRender } from "@/lib/email/platform-health";
import {
  MAIL_CRON_JOBS,
  MAIL_CRON_SCHEDULE,
  MAIL_RECIPIENTS_HEARTBEAT,
  classifyCrons,
  classifyMailCrons,
  classifyMailJobs,
  classifyMailRecipients,
  cronStateSentence,
  mailCronFailureSentences,
  pendingSentence,
  type MailCronJob,
  type PlatformEmailReason,
  type TenantReading,
} from "@/lib/ops/health-status";
import { DAILY_LIMIT_RESERVE_MIN, TENANT_MAIL_NEEDS_0114, readMailJobCounts, readTenantSmtpOverview, tenantDailyLimit } from "@/lib/notifications/smtp-state";
import { readAllStrict } from "@/lib/db/chunked";
import { SendTestButton } from "./send-test-button";
import { DailyLimitForm } from "./daily-limit-form";

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
 * With ADR 0029 pull request B (step 17; rules FP4 and FP8; the notes of
 * 2026-11-19 and 2026-11-20):
 *   - every organisation that is not deleted, with its reading, since when,
 *     its last error class, its last delivery, its count of the last 24
 *     hours and its daily limit, which a platform owner sets here (the
 *     limit route, audited);
 *   - the code and link jobs the platform ended (today and yesterday, UTC);
 *   - the last request that skipped its mail because its recipients could
 *     not be read;
 *   - "Reminder jobs": for reminders and journey-nudges, the state, the last
 *     run, the last successful run, the failure details as fixed sentences
 *     and the pending reminders. Its mark follows the health check's rule
 *     for the two jobs (MAIL_CRON_SCHEDULE, held equal to the route's lists
 *     by tests/unit/cron-cadence.test.ts); where crons are not scheduled it
 *     says "not scheduled here: shown, not counted".
 * Without migration 0114 one sentence that names it stands in place of the
 * organisations and the job numbers, and the page still renders. Counts and
 * fixed words only: no address, no database message.
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
  unknown: "bg-slate-100 text-slate-700 border-slate-200",
};

const READING_TEXT: Record<TenantReading, string> = {
  not_configured: "Not configured",
  configured: "Configured, nothing sent yet",
  healthy: "Healthy",
  failing: "Failing",
};

const JOB_LABEL: Record<MailCronJob, string> = {
  reminders: "Course reminders (daily)",
  "journey-nudges": "Journey nudges (hourly)",
};

const fmt = (iso: string | null | undefined) => (iso ? new Date(iso).toISOString().slice(0, 16).replace("T", " ") + " UTC" : "none");

function Badge({ status, label }: { status: string; label?: string }) {
  return (
    <span className={`text-xs font-bold uppercase tracking-wider px-2 py-1 rounded border ${STATUS_STYLE[status] ?? STATUS_STYLE.unknown}`}>
      {label ?? status}
    </span>
  );
}

export default async function PlatformEmailPage() {
  await requirePlatformOwner();
  const svc = createServiceClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } }
  );
  const weekAgo = new Date(Date.now() - 7 * 24 * 3_600_000).toISOString();
  const [health, lastRead, weekRead, overview, jobDays, beatRead, names] = await Promise.all([
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
    readTenantSmtpOverview(svc),
    readMailJobCounts(svc),
    // One read of the heartbeat rows this page shows: the last skip and the two mail crons.
    svc
      .from("ops_heartbeats")
      .select("name, last_run_at, last_status, last_detail")
      .in("name", [MAIL_RECIPIENTS_HEARTBEAT, ...MAIL_CRON_JOBS]),
    readAllStrict<{ id: string; name: string }>((from, to) =>
      svc.from("organizations").select("id, name").is("deleted_at", null).order("id").range(from, to)
    ),
  ]);
  const last = (Array.isArray(lastRead.data) ? lastRead.data[0] : null) as
    | { sent_at: string; event_type: string; status: string; error_code: string | null }
    | null
    | undefined;
  const sent7d = weekRead.error || typeof weekRead.count !== "number" ? null : weekRead.count;
  const nameOf = new Map(Array.isArray(names) ? names.map((n) => [n.id, n.name]) : []);

  const expectCrons = process.env.OPS_EXPECT_CRONS === "1";
  const beats =
    beatRead.error || !Array.isArray(beatRead.data)
      ? ("unreadable" as const)
      : (beatRead.data as Array<{ name: string; last_run_at: string; last_status: string; last_detail: unknown }>);
  const cronRule =
    beats === "unreadable"
      ? null
      : classifyCrons({
          cadenceMin: MAIL_CRON_SCHEDULE.cadenceMin,
          staleWarnOnly: MAIL_CRON_SCHEDULE.staleWarnOnly,
          staleDegradedAfterMin: MAIL_CRON_SCHEDULE.staleDegradedAfterMin,
          erroredWarn: MAIL_CRON_SCHEDULE.erroredWarn,
          rows: beats.map((b) => ({ name: b.name, last_run_at: b.last_run_at, last_status: b.last_status })),
          nowMs: Date.now(),
          expectCrons,
        });
  const mailCrons = classifyMailCrons({ rows: beats, crons: cronRule, expectCrons });
  const lastSkip = classifyMailRecipients({ rows: beats, nowMs: Date.now() });
  const lostJobs = classifyMailJobs(jobDays);
  const tenants =
    overview.kind === "ok"
      ? [...overview.rows].sort((a, b) => (nameOf.get(a.organization_id) ?? "").localeCompare(nameOf.get(b.organization_id) ?? ""))
      : [];
  const defaultLimit = tenantDailyLimit(null).limit;

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
          <Badge status={health.status} />
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

      <section className="bg-paper border border-line rounded-xl shadow-sm p-6 mb-6">
        <h2 className="text-lg font-semibold text-ink mb-2">Organisations&apos; email</h2>
        <p className="text-sm text-muted mb-4">
          Each organisation sends its learners&apos; mail through its own SMTP only. Routine mail
          stops at the daily limit less a reserve kept for reset codes, sign-in links and welcome
          mail; at the limit nothing more is sent until the 24 hours move on. Where no limit is
          set, the default ({defaultLimit}) applies.
        </p>
        {overview.kind === "missing" ? (
          <p className="text-sm text-ink">{TENANT_MAIL_NEEDS_0114}</p>
        ) : overview.kind === "unreadable" ? (
          <p className="text-sm text-ink">The organisations&apos; email state could not be read just now. Reload the page to try again.</p>
        ) : tenants.length === 0 ? (
          <p className="text-sm text-muted">No organisation.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-muted border-b border-line">
                  <th className="py-2 pr-4 font-medium">Organisation</th>
                  <th className="py-2 pr-4 font-medium">Reading</th>
                  <th className="py-2 pr-4 font-medium">Since</th>
                  <th className="py-2 pr-4 font-medium">Last error class</th>
                  <th className="py-2 pr-4 font-medium">Last delivery</th>
                  <th className="py-2 pr-4 font-medium">Sent in 24 hours</th>
                  <th className="py-2 font-medium">Daily limit</th>
                </tr>
              </thead>
              <tbody>
                {tenants.map((t) => (
                  <tr key={t.organization_id} className="border-b border-line align-top">
                    <td className="py-2 pr-4 text-ink">{nameOf.get(t.organization_id) ?? "(name not read)"}</td>
                    <td className="py-2 pr-4 text-ink">
                      {READING_TEXT[t.reading]}
                      {t.atLimit ? " · at its daily limit: all mail stopped" : t.routineOff ? " · routine mail off at this limit" : t.routineStopped ? " · routine mail stopped for today" : ""}
                    </td>
                    <td className="py-2 pr-4 text-ink">{t.reading === "not_configured" ? "" : fmt(t.since)}</td>
                    <td className="py-2 pr-4 font-mono text-xs text-ink">{t.lastErrorClass ?? ""}</td>
                    <td className="py-2 pr-4 text-ink">{fmt(t.lastSuccessAt)}</td>
                    <td className="py-2 pr-4 text-ink">
                      {t.sent24h} of {t.limit.limit}
                    </td>
                    <td className="py-2">
                      <DailyLimitForm organizationId={t.organization_id} storedLimit={t.storedLimit} defaultLimit={defaultLimit} reserveMin={DAILY_LIMIT_RESERVE_MIN} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="bg-paper border border-line rounded-xl shadow-sm p-6 mb-6">
        <h2 className="text-lg font-semibold text-ink mb-4">Lost mail and skipped mail</h2>
        <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-8 gap-y-3 text-sm">
          <dt className="text-muted">Code and link jobs the platform ended (today and yesterday, UTC)</dt>
          <dd className="text-ink">
            {jobDays === "missing" ? (
              TENANT_MAIL_NEEDS_0114
            ) : lostJobs.started === null || lostJobs.lost === null ? (
              "could not be read just now"
            ) : (
              <>
                <Badge status={lostJobs.status} /> {lostJobs.lost} lost of {lostJobs.started} started
              </>
            )}
          </dd>
          <dt className="text-muted">Last request that skipped its mail (its recipients could not be read)</dt>
          <dd className="text-ink">
            {lastSkip.status === "unknown" ? (
              "could not be read just now"
            ) : (
              <>
                <Badge status={lastSkip.status} /> {lastSkip.last_skip_at ? fmt(lastSkip.last_skip_at) : "none"}
              </>
            )}
          </dd>
        </dl>
        <p className="text-xs text-muted mt-4">
          A skip reads warn for 24 hours and clears by itself. The organisation and the request are
          in the Worker&apos;s log line, never on this page.
        </p>
      </section>

      <section className="bg-paper border border-line rounded-xl shadow-sm p-6 mb-6">
        <h2 className="text-lg font-semibold text-ink mb-2">Reminder jobs</h2>
        <p className="text-sm text-muted mb-4">
          {expectCrons
            ? "Scheduled here: a failed run reads warn on the health check until the job's next clean run."
            : "Not scheduled here: shown, not counted."}
        </p>
        {mailCrons.status === "unknown" ? (
          <p className="text-sm text-ink">The jobs&apos; heartbeats could not be read just now. Reload the page to try again.</p>
        ) : (
          <div className="space-y-5">
            {MAIL_CRON_JOBS.map((job) => {
              const j = mailCrons.jobs[job];
              if (!j) return null;
              const failures = mailCronFailureSentences(j.failure);
              return (
                <div key={job} className="border border-line rounded-lg p-4">
                  <div className="flex items-center gap-3 mb-2">
                    <h3 className="font-semibold text-ink">{JOB_LABEL[job]}</h3>
                    {expectCrons ? <Badge status={j.level} /> : <Badge status="unknown" label="not counted" />}
                  </div>
                  <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-8 gap-y-2 text-sm">
                    <dt className="text-muted">State</dt>
                    <dd className="text-ink">{cronStateSentence(j.state, expectCrons)}</dd>
                    <dt className="text-muted">Last run</dt>
                    <dd className="text-ink">{fmt(j.last_run_at)}</dd>
                    <dt className="text-muted">Last successful run</dt>
                    <dd className="text-ink">{j.last_ok_at ? fmt(j.last_ok_at) : "not known"}</dd>
                    <dt className="text-muted">Pending reminders</dt>
                    <dd className="text-ink">{pendingSentence(j.pending, j.failure)}</dd>
                    <dt className="text-muted">Failure details</dt>
                    <dd className="text-ink">
                      {failures.length === 0 ? (
                        j.failure ? "none" : "not known"
                      ) : (
                        <ul className="list-disc pl-5 space-y-1">
                          {failures.map((s) => (
                            <li key={s}>{s}</li>
                          ))}
                        </ul>
                      )}
                    </dd>
                  </dl>
                </div>
              );
            })}
          </div>
        )}
      </section>

      <section className="bg-paper border border-line rounded-xl shadow-sm p-6">
        <h2 className="text-lg font-semibold text-ink mb-2">Test</h2>
        <p className="text-sm text-muted mb-4">
          Sends the platform&apos;s fixed test message to your own account&apos;s address and
          records it in the audit log. Limited to 5 an hour and 10 a day that reach the mail
          server; a test that is not sent (not configured, or an address the allow-list does
          not allow) is not counted.
        </p>
        <SendTestButton />
      </section>
    </div>
  );
}

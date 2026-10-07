import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { createClient as createServiceClient } from "@supabase/supabase-js";
import { requireOrgAccess } from "@/lib/auth/require-org-access";
import { Avatar } from "@/components/ui/avatar";
import { canSeeEmail, loadManagerContext } from "@/lib/manager/access";
import { computeLearnerInsights } from "@/lib/manager/insights";
import { scopeForManager } from "@/lib/manager/coverage";
import { PERIODS, type ExceptionAction } from "@/lib/manager/types";
import { Card, Kpi, Pill, StatusPill, fmtDate, relativeDays } from "../_components/ui";
import { ActionButton, RaiseTicketButton } from "../_components/report-card-client";

export const dynamic = "force-dynamic";

/**
 * Employee report (§5): opens from any name on the Report Card. The admin
 * Learner 360, re-skinned for managers — plain status, the next thing to do,
 * and the actions a manager may take. Scope-checked: anyone in the viewer's
 * hierarchy (direct team, or a team under them as L2/L3); anyone else is a
 * 404, never a leak. Email shows only for the viewer's own direct reports
 * (§12: names, never emails, outside the L1 view).
 */
export default async function EmployeeReportPage({
  params,
  searchParams,
}: {
  params: Promise<{ org: string; userId: string }>;
  searchParams?: Promise<{ period?: string }>;
}) {
  const { org: orgSlug, userId } = await params;
  const sp = (await searchParams) ?? {};
  const { user, org } = await requireOrgAccess(orgSlug);
  const svc = createServiceClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } }
  );
  const ctx = await loadManagerContext(svc, org.id, user.id);
  if (!ctx.scope.all.has(userId)) notFound();
  const showEmail = canSeeEmail(ctx, userId);
  const isDirect = ctx.scope.direct.has(userId);
  // Where this person sits: their L1 inside the hierarchy (for the back link).
  const l1Id = ctx.members.find((m) => m.user_id === userId)?.line_manager_id ?? null;
  const backHref = isDirect || !l1Id || !ctx.scope.teamsByL1.has(l1Id) ? `/${orgSlug}/team-performance` : `/${orgSlug}/team-performance/team/${l1Id}`;

  const period = PERIODS.find((p) => p.value === (sp.period ?? "30")) ?? PERIODS[1];
  const raw = await computeLearnerInsights(svc, {
    orgId: org.id,
    orgSlug,
    userIds: [userId],
    periodDays: period.days,
  });
  const nowMs = Date.now();
  // Phase 4c: only content inside the viewer's coverage is shown; the rest is a count.
  const scoped = await scopeForManager(svc, { orgId: org.id, viewerId: user.id, learners: raw.learners, catalog: raw.catalog, periodDays: period.days, nowMs });
  const l = scoped.learners[0];
  if (!l) notFound();
  const hiddenCount = scoped.hiddenByUser.get(userId) ?? 0;
  const coverage = scoped.coverage;
  const activeJourney = l.journeys.find((j) => j.status === "active") ?? null;
  const reasons = l.flags.filter((f) => f.kind !== "needs_support").map((f) => f.detail);

  // Suggested actions (§5): one per exception the person actually has.
  const actions: ExceptionAction[] = [];
  for (const c of l.courses) {
    if ((c.status === "failed" || c.passRequiredUnmet) && c.limitReached && !c.openGrant) {
      actions.push({ kind: "ticket", label: `Raise ticket · retry on ${c.title}`, category: "grant_retry", people: [{ userId: l.userId, name: l.name }], content: { kind: "course", id: c.courseId, title: c.title }, exception: "failed" });
    }
  }
  if (activeJourney && !activeJourney.onTrack) actions.push({ kind: "remind", label: "Send journey reminder", target: "journey", contentId: activeJourney.programId, userIds: [l.userId] });
  for (const f of l.flags) {
    if ((f.kind === "stuck" || f.kind === "overdue" || f.kind === "not_started") && f.contentKind === "course" && f.contentId) {
      actions.push({ kind: "remind", label: `${f.kind === "not_started" ? "Send start reminder" : "Send reminder"} · ${f.contentTitle}`, target: f.kind === "not_started" ? "start" : "course", contentId: f.contentId, userIds: [l.userId] });
    }
  }
  const seen = new Set<string>();
  const uniqueActions = actions.filter((a) => {
    const k = a.kind === "ticket" ? `t:${a.category}:${a.content?.id ?? ""}` : a.kind === "remind" ? `r:${a.contentId}` : "";
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  }).slice(0, 4);
  const openGrants = l.courses.filter((c) => c.openGrant);

  // A pass-required module that is not passed reads as "Not passed" (red), never as a green "Completed".
  const statusWord = (c: { status: string; passRequiredUnmet: boolean }) =>
    c.passRequiredUnmet && c.status !== "failed" ? "Not passed" : ({ not_started: "Not started", in_progress: "In progress", completed: "Completed", passed: "Passed", failed: "Failed" } as Record<string, string>)[c.status] ?? c.status;
  const statusTone = (c: { status: string; passRequiredUnmet: boolean }) =>
    c.status === "failed" || c.passRequiredUnmet ? "bad" : c.status === "passed" || c.status === "completed" ? "ok" : c.status === "in_progress" ? "warn" : "none";

  return (
    // data-dashboard-root: keeps the page root untransformed so the assign dialog's fixed overlay positions correctly.
    <div data-dashboard-root="" className="max-w-5xl mx-auto space-y-6">
      <Link href={backHref} className="inline-flex items-center gap-1.5 text-sm text-muted hover:text-ink">
        <ArrowLeft className="w-4 h-4" /> {isDirect ? "Back to Team Performance" : "Back to the team"}
      </Link>

      <div className="bg-paper border border-line rounded-2xl p-6 flex flex-wrap items-center gap-5">
        <Avatar name={l.name} avatarUrl={l.avatarUrl} size="lg" />
        <div className="min-w-0 flex-1">
          <h1 className="serif text-3xl leading-tight">{l.name}</h1>
          <p className="text-sm text-muted mt-0.5">
            {[l.designation, l.city, l.branch].filter(Boolean).join(" · ") || "—"}
            {showEmail && l.email ? ` · ${l.email}` : ""}
          </p>
          <p className="text-xs text-muted mt-1">{l.joined ? `Joined ${fmtDate(l.joined)} · ` : ""}{isDirect ? "Reports to you" : "In your reporting line"}</p>
        </div>
        <div className="text-right">
          <StatusPill status={l.status} />
          {reasons.length > 0 && <p className="text-[11px] text-muted mt-1 max-w-[260px]">{reasons.join(" · ")}</p>}
        </div>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Kpi label="Completion" value={l.completionPct === null ? "—" : `${l.completionPct}%`} sub={`${l.completed} of ${l.assigned} assigned`} tone={l.completionPct === null ? undefined : l.completionPct >= 85 ? "ok" : l.completionPct >= 65 ? "warn" : "bad"} />
        <Kpi label="Avg official score" value={l.avgScore === null ? "—" : String(l.avgScore)} sub={`${l.courses.filter((c) => c.status === "failed" || c.passRequiredUnmet).length} failed · ${l.courses.filter((c) => c.status === "passed").length} passed`} tone={l.avgScore === null ? undefined : l.avgScore >= 75 ? "ok" : l.avgScore >= 60 ? "warn" : "bad"} />
        <Kpi label="Journey" value={activeJourney ? `${activeJourney.day}/${activeJourney.total}` : l.journeys[0]?.status === "completed" ? "Done" : "—"} sub={activeJourney ? (activeJourney.behind ? `${activeJourney.behind} days behind` : activeJourney.overdueDeadline ? "past deadline" : `on track · next: ${activeJourney.nextModule ?? "—"}`) : null} tone={activeJourney ? (activeJourney.onTrack ? "ok" : activeJourney.behind >= 3 ? "bad" : "warn") : undefined} />
        <Kpi label="Last active" value={relativeDays(l.lastActive, nowMs)} sub={l.lastActive ? fmtDate(l.lastActive) : "no learning activity yet"} tone={l.inactiveDays === null ? undefined : l.inactiveDays >= 14 ? "bad" : l.inactiveDays >= 7 ? "warn" : "ok"} />
      </div>

      <Card eyebrow="Suggested actions">
        <div className="flex flex-wrap gap-2">
          {uniqueActions.map((a, i) => (
            <ActionButton key={i} orgSlug={orgSlug} action={a} primary={i === 0} />
          ))}
          <RaiseTicketButton orgSlug={orgSlug} label="Raise a support ticket" category="other" people={[{ userId: l.userId, name: l.name }]} content={null} exception={null} origin={`team-performance/${l.userId}`} />
        </div>
        {openGrants.length > 0 && (
          <p className="text-xs text-muted mt-2">Already holds an unused extra attempt on {openGrants.map((c) => c.title).join(", ")}.</p>
        )}
        {uniqueActions.length === 0 && <p className="text-xs text-muted mt-2">Nothing is flagged — nothing to chase right now.</p>}
      </Card>

      <section className="bg-paper border border-line rounded-2xl overflow-hidden">
        <h2 className="font-semibold text-sm px-5 pt-4 pb-2">
          Courses ({l.courses.length})
          {coverage.hasVertical ? <span className="ml-2 text-[11px] font-normal text-muted">within {coverage.label}</span> : <span className="ml-2 text-[11px] font-normal text-amber-700">your Business Vertical is not set — ask your administrator</span>}
          {hiddenCount > 0 && <span className="ml-2 text-[11px] font-normal text-muted" data-testid="hidden-count">· {hiddenCount} {hiddenCount === 1 ? "item" : "items"} outside your coverage not shown</span>}
        </h2>
        <div className="overflow-x-auto">
          <table className="w-full text-sm min-w-[680px]">
            <thead>
              <tr className="text-left text-[11px] uppercase tracking-wide text-muted border-b border-line">
                <th className="px-5 py-2">Course</th>
                <th className="px-3 py-2">Status</th>
                <th className="px-3 py-2 text-right">Progress</th>
                <th className="px-3 py-2 text-right">Score</th>
                <th className="px-3 py-2 text-right">Attempts</th>
                <th className="px-3 py-2">Due</th>
                <th className="px-5 py-2">Last activity</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {l.courses.map((c) => (
                <tr key={c.courseId}>
                  <td className="px-5 py-2.5 font-medium">{c.title}{c.passRequiredUnmet && c.status !== "failed" ? <span className="block text-[11px] text-red-700 font-normal">pass required · not passed</span> : null}</td>
                  <td className="px-3 py-2.5"><Pill tone={statusTone(c)}>{statusWord(c)}</Pill></td>
                  <td className="px-3 py-2.5 text-right tabular-nums">{c.status === "not_started" ? "—" : c.progressPct === null ? "In progress" : `${c.progressPct}%`}</td>
                  <td className="px-3 py-2.5 text-right tabular-nums">{c.officialScore === null ? "—" : c.officialScore}</td>
                  <td className="px-3 py-2.5 text-right tabular-nums">{c.attempts}</td>
                  <td className={`px-3 py-2.5 text-xs ${c.overdue ? "text-red-700 font-semibold" : "text-muted"}`}>{c.dueAt ? `${fmtDate(c.dueAt)}${c.overdue ? " · overdue" : ""}` : "—"}</td>
                  <td className="px-5 py-2.5 text-xs text-muted">{c.lastActivity ? relativeDays(c.lastActivity, nowMs) : "—"}{c.nudges ? ` · ${c.nudges} reminder${c.nudges === 1 ? "" : "s"}` : ""}</td>
                </tr>
              ))}
              {l.courses.length === 0 && <tr><td colSpan={7} className="px-5 py-6 text-center text-sm text-muted">Nothing assigned yet.</td></tr>}
            </tbody>
          </table>
        </div>
      </section>

      {(l.paths.length > 0 || l.journeys.length > 0) && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {l.journeys.length > 0 && (
            <Card eyebrow="Journeys">
              <ul className="space-y-2 text-sm">
                {l.journeys.map((j) => (
                  <li key={j.programId} className="flex flex-wrap items-baseline justify-between gap-2">
                    <span className="font-medium">{j.name}</span>
                    <span className="text-muted text-xs">
                      {j.status === "completed" ? "Completed 🎉" : `Day ${j.day} of ${j.total} · ${j.daysDone} missions done`}
                      {j.behind > 0 && <strong className="text-red-700"> · {j.behind}d behind</strong>}
                      {j.overdueDeadline && <strong className="text-red-700"> · past deadline</strong>}
                      {j.status === "active" && j.nextModule ? ` · next: ${j.nextModule}` : ""}
                    </span>
                  </li>
                ))}
              </ul>
            </Card>
          )}
          {l.paths.length > 0 && (
            <Card eyebrow="Learning paths">
              <ul className="space-y-2 text-sm">
                {l.paths.map((p) => (
                  <li key={p.pathId} className="flex flex-wrap items-baseline justify-between gap-2">
                    <span className="font-medium">{p.name}</span>
                    <span className={`text-xs ${p.overdue ? "text-red-700 font-semibold" : "text-muted"}`}>
                      {p.stepsDone}/{p.stepsTotal} steps{p.dueAt ? ` · due ${fmtDate(p.dueAt)}` : ""}{p.overdue ? " · overdue" : ""}
                    </span>
                  </li>
                ))}
              </ul>
            </Card>
          )}
        </div>
      )}
    </div>
  );
}

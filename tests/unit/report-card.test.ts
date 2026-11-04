/**
 * Unit test for the Manager Report Card rules (Phase 1; decisions 4 and 5):
 * the Team Learning Score (weights 35/25/25/15, journey weight redistributed),
 * the §3 exception groups (severity-first, max five), the per-person status
 * words, and the §10 struggle diagnosis.
 *
 * ADR 0014 (PR 1b): revision rows skipped by the engagement folds and
 * "Last revisit" beside the inactive flag; step 10's retake state and the
 * result it replaces on the course line; the strict grant read of
 * ADR 0014:188: a
 * failed read degrades every learner to "History unavailable" with no
 * figure, the team folds leave them out and say how many, the precompute
 * caches no degraded batch, and the reminder action and the views are
 * source-checked (they load next/* or a cookie client).
 * computeLearnerInsights and refreshOrgCache run over a recording fake of
 * the supabase-js query builder.
 *
 * Run:  npx tsx tests/unit/report-card.test.ts
 * (No DB. Typechecked by `npm run typecheck`.)
 */
import fs from "node:fs";
import path from "node:path";
import {
  buildCommonStruggles,
  buildExceptions,
  buildOrgGaps,
  buildStruggles,
  buildTeamExceptions,
  teamCards,
  teamSeverity,
  compareWorstFirst,
  matchesStatusFilter,
  periodSummary,
  riskOf,
  statusOf,
  teamScore,
  toneFor,
  THRESHOLDS,
} from "../../lib/manager/report-card";
import type { CourseLine, ExceptionFlag, LearnerInsight } from "../../lib/manager/types";
import { l2GroupsOf, type ManagerContext } from "../../lib/manager/access";
import { resolveManagerScope, type HierarchyMember } from "../../lib/org/reporting-line";
import { deriveLearner } from "../../lib/manager/derive";
import { applyCoverage } from "../../lib/manager/coverage";
import { computeLearnerInsights } from "../../lib/manager/insights";
import { refreshOrgCache } from "../../lib/manager/cache";

let pass = 0, fail = 0;
const eq = (n: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n} — got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); }
};

const flag = (kind: ExceptionFlag["kind"], severity: ExceptionFlag["severity"] = "normal", contentId: string | null = null, title: string | null = null): ExceptionFlag =>
  ({ kind, severity, contentId, contentKind: contentId ? "course" : null, contentTitle: title, detail: `${kind}` });

const learner = (over: Partial<LearnerInsight> & { userId: string }): LearnerInsight => ({
  name: over.userId, email: `${over.userId}@example.test`, avatarUrl: null, designation: null, city: null, branch: null, vertical: null, department: null, joined: null,
  assigned: 0, completed: 0, completionPct: null, avgScore: null, assessmentsWithResult: 0, passedFirstTime: 0,
  lastActive: null, inactiveDays: null, activeLast7d: false, journeys: [], courses: [], paths: [],
  flags: [], risk: 0, status: "on_track", completedInPeriod: 0, passedFirstTimeInPeriod: 0, journeyDaysInPeriod: 0, completedInPrevPeriod: 0,
  ...over,
});
const journey = (behind: number, status: "active" | "completed" = "active") => ({
  programId: "j1", name: "30-day", status, unlockMode: "calendar" as const, day: 5, total: 30, behind, overdueDeadline: false,
  daysDone: 4, courseDays: 30, nextModule: "Pricing", onTrack: status !== "active" || behind === 0, daysInPeriod: 0,
});

console.log("\nteam score (decision 4)");
{
  // 10 assigned / 8 done → 80 (warn); scores avg 78 (ok); journey 1 of 2 on track → 50 (bad); 3 of 4 active → 75 (ok)
  const team = [
    learner({ userId: "a", assigned: 5, completed: 5, avgScore: 80, activeLast7d: true, journeys: [journey(0)] }),
    learner({ userId: "b", assigned: 5, completed: 3, avgScore: 76, activeLast7d: true, journeys: [journey(2)] }),
    learner({ userId: "c", activeLast7d: true }),
    learner({ userId: "d" }),
  ];
  const s = teamScore(team);
  eq("signal values", s.signals.map((x) => x.value), [80, 78, 50, 75]);
  eq("signal tones", s.signals.map((x) => x.tone), ["warn", "ok", "bad", "ok"]);
  // (80*35 + 78*25 + 50*25 + 75*15) / 100 = 71.25 → 71 → warn
  eq("weighted score + label", [s.score, s.tone, s.label], [71, "warn", "Needs attention"]);
}
{
  const team = [learner({ userId: "a", assigned: 4, completed: 4, avgScore: 90, activeLast7d: true })];
  const s = teamScore(team);
  eq("no journey → weight redistributed (100*35+90*25+100*15)/75 = 97", [s.signals[2].value, s.score, s.label], [null, 97, "Good"]);
  eq("empty team → no score", teamScore([]).score, null);
  eq("one idle learner, nothing assigned → engagement alone gives NO score", [teamScore([learner({ userId: "z" })]).score, teamScore([learner({ userId: "z" })]).signals.filter((x) => x.value !== null).map((x) => x.key)], [null, ["engagement"]]);
}
eq("toneFor thresholds", [toneFor(85, THRESHOLDS.completion), toneFor(84, THRESHOLDS.completion), toneFor(64, THRESHOLDS.completion), toneFor(null, THRESHOLDS.completion)], ["ok", "warn", "bad", "none"]);

console.log("\nper-person status (decision 5)");
{
  eq("no flags → on track", statusOf([], 0), "on_track");
  eq("one flag → watch", statusOf([flag("not_started")], 2), "watch");
  eq("two distinct kinds → needs support", statusOf([flag("failed", "critical"), flag("inactive")], 2), "needs_support");
  eq("risk ≥ 5 alone → needs support", statusOf([flag("overdue", "critical")], 6), "needs_support");
  eq("risk: behind≥3 (+3) + 2 overdue (+4) + failed (+2) = 9", riskOf([flag("behind", "critical"), flag("overdue", "critical"), flag("overdue", "critical"), flag("failed", "critical")], 3, 0), 9);
  eq("risk: inactive 21d (+3), chronic nudges (+2)", riskOf([flag("inactive", "high")], 21, 3), 5);
  const a = learner({ userId: "a", status: "watch", risk: 3 }), b = learner({ userId: "b", status: "needs_support", risk: 6 }), c = learner({ userId: "c" });
  eq("worst first", [b, c, a].sort(compareWorstFirst).map((l) => l.userId), ["b", "a", "c"]);
  eq("status filter by word and by flag", [matchesStatusFilter(b, "needs_support"), matchesStatusFilter(a, "failed"), matchesStatusFilter(learner({ userId: "x", flags: [flag("failed", "critical")] }), "failed")], [true, false, true]);
}

console.log("\nexceptions (§3): severity first, max five, content + actions");
{
  const team = [
    learner({ userId: "arjun", name: "Arjun", risk: 7, status: "needs_support", flags: [flag("failed", "critical", "c1", "Objection Handling"), flag("inactive", "high"), flag("needs_support", "critical")],
      courses: [{ courseId: "c1", title: "Objection Handling", status: "failed", officialScore: 48, attempts: 1, progressPct: 100, assignedAt: null, dueAt: null, overdue: false, startedAt: null, lastActivity: null, passedFirstTime: false, passRequiredUnmet: false, nudges: 0, completedAt: null, done: false, isAssigned: true, openGrant: false, limitReached: true }] }),
    learner({ userId: "meera", name: "Meera", risk: 2, status: "watch", flags: [flag("failed", "critical", "c1", "Objection Handling")],
      courses: [{ courseId: "c1", title: "Objection Handling", status: "failed", officialScore: 55, attempts: 1, progressPct: 100, assignedAt: null, dueAt: null, overdue: false, startedAt: null, lastActivity: null, passedFirstTime: false, passRequiredUnmet: false, nudges: 0, completedAt: null, done: false, isAssigned: true, openGrant: true, limitReached: true }] }),
    learner({ userId: "nikhil", name: "Nikhil", risk: 2, status: "watch", flags: [flag("not_started", "normal", "c2", "Compliance Basics")] }),
    learner({ userId: "pooja", name: "Pooja", risk: 1, status: "watch", flags: [flag("behind", "high", "j1", "30-day")] }),
    learner({ userId: "sahil", name: "Sahil", risk: 0, status: "watch", flags: [flag("stuck", "high", "c3", "Pricing")] }),
    learner({ userId: "kabir", name: "Kabir", risk: 0, status: "watch", flags: [flag("inactive", "normal")] }),
  ];
  const g = buildExceptions(team, { orgSlug: "acme" });
  // severity first, then count, then the §3 table order for ties
  eq("max five groups, severity-ordered", g.map((x) => `${x.kind}:${x.severity}:${x.count}`), [
    "failed:critical:2", "needs_support:critical:1", "inactive:high:2", "behind:high:1", "stuck:high:1",
  ]);
  const failed = g.find((x) => x.kind === "failed")!;
  eq("failed group names the module and the people (worst first)", [failed.content?.title, failed.people.map((p) => p.name)], ["Objection Handling", ["Arjun", "Meera"]]);
  const tk = failed.actions.find((a) => a.kind === "ticket");
  eq("ticket (grant retry) names only learners without an open grant, with the module", tk && tk.kind === "ticket" ? [tk.category, tk.people.map((p) => p.userId), tk.content?.id, tk.exception] : null, ["grant_retry", ["arjun"], "c1", "failed"]);
  eq("no direct grant action exists any more (decision 12)", failed.actions.some((a) => (a as { kind: string }).kind === "grant"), false);
  eq("not_started dropped by the cap (lowest severity, count 1)", g.some((x) => x.kind === "not_started"), false);
  eq("names can be hidden for non-L1 views", buildExceptions(team, { orgSlug: "acme", namesVisible: false })[1].people[0].name, "A team member");
  eq("stuck group links to the stuck filter", g.find((x) => x.kind === "stuck")?.actions.find((a) => a.kind === "link"), { kind: "link", label: "View learners", href: "/acme/team-performance?status=stuck" });
}
{
  // A learner failed on TWO modules: the tally counts every flag, so the module
  // two people failed wins and both are offered the retry; a learner whose
  // official window is not used up is never offered a grant.
  const l = (courseId: string, title: string, limitReached = true) => ({ courseId, title, status: "failed" as const, officialScore: 40, attempts: 1, progressPct: 100, assignedAt: null, dueAt: null, overdue: false, startedAt: null, lastActivity: null, passedFirstTime: false, passRequiredUnmet: false, nudges: 0, completedAt: null, done: false, isAssigned: true, openGrant: false, limitReached });
  const team = [
    learner({ userId: "arjun", name: "Arjun", flags: [flag("failed", "critical", "c1", "Alpha"), flag("failed", "critical", "c2", "Objection Handling")], courses: [l("c1", "Alpha"), l("c2", "Objection Handling")] }),
    learner({ userId: "meera", name: "Meera", flags: [flag("failed", "critical", "c2", "Objection Handling")], courses: [l("c2", "Objection Handling")] }),
    learner({ userId: "sahil", name: "Sahil", flags: [flag("failed", "critical", "c2", "Objection Handling")], courses: [l("c2", "Objection Handling", false)] }),
  ];
  const g = buildExceptions(team, { orgSlug: "acme" })[0];
  const grant = g.actions.find((a) => a.kind === "ticket");
  eq("most common module across ALL failed flags", [g.count, g.content?.title], [3, "Objection Handling"]);
  eq("ticket people = everyone who failed THAT module with the window used up", grant && grant.kind === "ticket" ? [grant.content?.id, grant.people.map((p) => p.userId).sort()] : null, ["c2", ["arjun", "meera"]]);
  // behind: the reminder goes only to people behind on the chosen journey
  const b = [
    learner({ userId: "a", flags: [flag("behind", "high", "j1", "30-day")] }),
    learner({ userId: "b", flags: [flag("behind", "high", "j1", "30-day")] }),
    learner({ userId: "pooja", flags: [flag("behind", "critical", "j2", "Onboarding")] }),
  ];
  const bg = buildExceptions(b, { orgSlug: "acme" })[0];
  const r = bg.actions.find((a) => a.kind === "remind");
  eq("behind reminder targets only the chosen journey's people", r && r.kind === "remind" ? [r.contentId, r.userIds.sort()] : null, ["j1", ["a", "b"]]);
}

console.log("\nstruggles (§10): pivot + benchmark diagnosis");
{
  const line = (courseId: string, title: string, status: "failed" | "passed" | "not_started"): LearnerInsight["courses"][number] =>
    ({ courseId, title, status, officialScore: status === "not_started" ? null : 50, attempts: status === "not_started" ? 0 : 1, progressPct: null, assignedAt: null, dueAt: null, overdue: false, startedAt: null, lastActivity: null, passedFirstTime: false, passRequiredUnmet: false, nudges: 0, completedAt: null, done: false, isAssigned: true, openGrant: false, limitReached: status === "failed" });
  const team = [
    learner({ userId: "a", flags: [flag("failed", "critical", "c1", "Objection Handling")], courses: [line("c1", "Objection Handling", "failed")] }),
    learner({ userId: "b", flags: [flag("failed", "critical", "c1", "Objection Handling")], courses: [line("c1", "Objection Handling", "failed")] }),
    learner({ userId: "c", flags: [], courses: [line("c1", "Objection Handling", "passed")] }),
    learner({ userId: "d", flags: [flag("not_started", "normal", "c2", "Compliance")], courses: [line("c2", "Compliance", "not_started")] }),
    learner({ userId: "e", flags: [flag("behind", "high", "j1", "30-day")], journeys: [journey(2)] }),
  ];
  const s = buildStruggles(team, new Map([["c1", { failRate: 8, enrolled: 200 }]]));
  eq("ranked by total; team 67% vs org 8% → team problem", [s[0].title, s[0].failed, s[0].teamFailRate, s[0].orgFailRate, s[0].diagnosis], ["Objection Handling", 2, 67, 8, "team"]);
  eq("fresh not-started → timing", s.find((x) => x.id === "c2")?.diagnosis, "timing");
  eq("journey day pending row", s.find((x) => x.kind === "journey-day")?.title, "Day 5 · Pricing");
  const s2 = buildStruggles(team, new Map([["c1", { failRate: 30, enrolled: 200 }]]));
  eq("org rate high too → content problem", s2[0].diagnosis, "content");
}

console.log("\nperiod summary");
{
  const team = [learner({ userId: "a", completedInPeriod: 3, completedInPrevPeriod: 1, passedFirstTimeInPeriod: 2, assessmentsWithResult: 2, journeyDaysInPeriod: 10 }), learner({ userId: "b", completedInPeriod: 1, completedInPrevPeriod: 2 })];
  eq("sums + delta", periodSummary(team, 30), { days: 30, coursesCompleted: 4, passedFirstTime: 2, assessmentsWithResult: 2, journeyMissions: 10, completionsDelta: 1, unavailable: 0 });
  eq("all-time has no delta", periodSummary(team, null).completionsDelta, null);
}


console.log("\nL2 (§6): teams compared, team exceptions, common struggles");
{
  const fl = (courseId: string, title: string) => ({ courseId, title, status: "failed" as const, officialScore: 40, attempts: 1, progressPct: 100, assignedAt: null, dueAt: null, overdue: false, startedAt: null, lastActivity: null, passedFirstTime: false, passRequiredUnmet: false, nudges: 0, completedAt: null, done: false, isAssigned: true, openGrant: false, limitReached: true });
  const people = [
    // Team A (bad): two failed Objection Handling, one overdue
    learner({ userId: "a1", assigned: 4, completed: 1, avgScore: 50, status: "needs_support", risk: 6, flags: [flag("failed", "critical", "c1", "Objection Handling"), flag("overdue", "critical", "c2", "Compliance")], courses: [fl("c1", "Objection Handling")] }),
    learner({ userId: "a2", assigned: 4, completed: 2, avgScore: 55, status: "watch", risk: 2, flags: [flag("failed", "critical", "c1", "Objection Handling")], courses: [fl("c1", "Objection Handling")] }),
    // Team B (ok-ish): one failed Objection Handling, everyone active
    learner({ userId: "b1", assigned: 4, completed: 4, avgScore: 85, activeLast7d: true, status: "watch", risk: 2, flags: [flag("failed", "critical", "c1", "Objection Handling")], courses: [fl("c1", "Objection Handling")] }),
    learner({ userId: "b2", assigned: 4, completed: 4, avgScore: 90, activeLast7d: true }),
    // Own team (good)
    learner({ userId: "o1", assigned: 3, completed: 3, avgScore: 88, activeLast7d: true }),
  ];
  const byId = new Map(people.map((l) => [l.userId, l]));
  const teams = [
    { managerId: "mgrA", managerName: "Asha", memberIds: ["a1", "a2"], isOwn: false },
    { managerId: "mgrB", managerName: "Bala", memberIds: ["b1", "b2"], isOwn: false },
    { managerId: "me", managerName: "Me", memberIds: ["o1"], isOwn: true },
  ];
  const cards = teamCards(teams, byId, 30);
  eq("worst team first, own (good) team last", cards.map((c) => c.managerId), ["mgrA", "mgrB", "me"]);
  const A = cards[0];
  eq("team counts are PEOPLE with the flag", [A.failed, A.overdue, A.needsSupport, A.topFailed?.title, A.topFailed?.n], [2, 1, 1, "Objection Handling", 2]);
  eq("severity: bad score / 3 critical → critical; a clean team → none", [teamSeverity(A), teamSeverity(cards[2])], ["critical", null]);
  const ex = buildTeamExceptions(cards, { orgSlug: "acme", managerEmail: (id) => (id === "mgrA" ? "asha@x.test" : null) });
  eq("team exceptions: Asha first with a why + review suggestion + open/email actions", [ex[0].managerId, /2 failed Objection Handling/.test(ex[0].summary), /1 overdue/.test(ex[0].summary), ex[0].suggestion, ex[0].actions.map((a) => a.label)], ["mgrA", true, true, "Review with Asha this week", ["Open team report", "Email Asha", "Raise ticket"]]);
  eq("clean own team is not listed", ex.some((e) => e.managerId === "me"), false);
  const cs = buildCommonStruggles(teams, byId);
  eq("Objection Handling fails in 2 of 3 teams → content gap", [cs[0].title, cs[0].teamsAffected, cs[0].teamsFailing, cs[0].teamsTotal, cs[0].failed, cs[0].diagnosis], ["Objection Handling", 2, 2, 3, 3, "content"]);
  eq("no email callback / non-direct manager → no mailto action; the ticket names the team's flagged people", (() => { const acts = buildTeamExceptions(cards, { orgSlug: "acme", managerEmail: () => null })[0].actions; const t = acts.find((x) => x.kind === "ticket"); return [acts.map((x) => x.label), t && t.kind === "ticket" ? t.people.map((p) => p.userId).sort() : null]; })(), [["Open team report", "Raise ticket"], ["a1", "a2"]]);
  eq("team link carries the page's query", buildTeamExceptions(cards, { orgSlug: "acme", query: "?period=90" })[0].actions[0], { kind: "link", label: "Open team report", href: "/acme/team-performance/team/mgrA?period=90" });
  // A person failed TWO modules in one team: still one failed person; the module tally counts both.
  const twice = [learner({ userId: "t1", flags: [flag("failed", "critical", "c1", "Alpha"), flag("failed", "critical", "c2", "Beta")], courses: [fl("c1", "Alpha"), fl("c2", "Beta")] })];
  const tc = teamCards([{ managerId: "m", managerName: "M", memberIds: ["t1"], isOwn: false }], new Map(twice.map((l) => [l.userId, l])), 30)[0];
  eq("team counts people, not flags", [tc.failed, tc.topFailed?.n], [1, 1]);
  // Three people failing three different modules: the summary must not say "3 failed Alpha".
  const three = ["x", "y", "z"].map((id, i) => learner({ userId: id, assigned: 2, completed: 0, avgScore: 30, flags: [flag("failed", "critical", `c${i}`, ["Alpha", "Beta", "Gamma"][i])], courses: [fl(`c${i}`, ["Alpha", "Beta", "Gamma"][i])] }));
  const tex = buildTeamExceptions(teamCards([{ managerId: "m3", managerName: "Mo", memberIds: ["x", "y", "z"], isOwn: false }], new Map(three.map((l) => [l.userId, l])), 30), { orgSlug: "acme" })[0];
  eq("summary names the most-failed module only with its own count", /^3 failed \(most on Alpha: 1\)/.test(tex.summary), true);
  // Common struggles: a module failing in ONE team but merely not started in two others is NOT a content gap, and a double-flagged learner counts once.
  const spread = [
    learner({ userId: "s1", flags: [flag("failed", "critical", "k", "Kappa"), flag("overdue", "critical", "k", "Kappa")], courses: [fl("k", "Kappa")] }),
    learner({ userId: "s2", flags: [flag("not_started", "normal", "k", "Kappa")] }),
    learner({ userId: "s3", flags: [flag("not_started", "normal", "k", "Kappa")] }),
  ];
  const sp = buildCommonStruggles([
    { managerId: "a", managerName: "A", memberIds: ["s1"], isOwn: false },
    { managerId: "b", managerName: "B", memberIds: ["s2"], isOwn: false },
    { managerId: "c", managerName: "C", memberIds: ["s3"], isOwn: false },
  ], new Map(spread.map((l) => [l.userId, l])))[0];
  eq("flagged in 3 teams but failing in 1 → spread, not content; learners are distinct people", [sp.teamsAffected, sp.teamsFailing, sp.learners, sp.diagnosis], [3, 1, 3, "spread"]);
  const c2 = cs.find((x) => x.id === "c2");
  eq("Compliance overdue in one team only → listed, no diagnosis", c2 ? [c2.teamsAffected, c2.overdue, c2.diagnosis] : "missing", [1, 1, null]);
}

console.log("\nL3 (§7): org-wide learning gaps, L2 groups");
{
  const fl = (courseId: string, title: string, status: "failed" | "not_started" | "in_progress" = "failed", assignedAt: string | null = "2026-09-01") =>
    ({ courseId, title, status, officialScore: status === "failed" ? 40 : null, attempts: status === "failed" ? 1 : 0, progressPct: status === "failed" ? 100 : 0, assignedAt, dueAt: null, overdue: false, startedAt: null, lastActivity: null, passedFirstTime: false, passRequiredUnmet: false, nudges: 0, completedAt: null, done: false, isAssigned: true, openGrant: false, limitReached: status === "failed" });
  const people = [
    // Objection Handling fails in Mumbai (2) and Pune (1); Compliance not started in 3 of 4 assigned; a journey day pending in two cities.
    learner({ userId: "m1", city: "Mumbai", flags: [flag("failed", "critical", "c1", "Objection Handling"), flag("not_started", "normal", "c2", "Compliance")], courses: [fl("c1", "Objection Handling"), fl("c2", "Compliance", "not_started")], journeys: [journey(2)] }),
    learner({ userId: "m2", city: "Mumbai", flags: [flag("failed", "critical", "c1", "Objection Handling"), flag("not_started", "normal", "c2", "Compliance")], courses: [fl("c1", "Objection Handling"), fl("c2", "Compliance", "not_started")] }),
    learner({ userId: "p1", city: "Pune", flags: [flag("failed", "critical", "c1", "Objection Handling"), flag("not_started", "normal", "c2", "Compliance")], courses: [fl("c1", "Objection Handling"), fl("c2", "Compliance", "not_started")], journeys: [journey(3)] }),
    learner({ userId: "p2", city: "Pune", courses: [fl("c1", "Objection Handling", "in_progress"), fl("c2", "Compliance", "in_progress")] }),
    learner({ userId: "d1", city: null, courses: [fl("c1", "Objection Handling", "in_progress")] }),
  ];
  const bench = new Map([["c1", { failRate: 12, enrolled: 400 }]]);
  const gaps = buildOrgGaps(people, bench, (l) => l.city ?? "No city", 3);
  eq("ranked by distinct people flagged, then groups", gaps.map((g) => [g.id, g.learners, g.groupsAffected]), [["c1", 3, 2], ["c2", 3, 2], ["j1:5", 2, 2]]);
  const c1 = gaps[0];
  eq("fail rate over everyone WITH the course (3 of 5), org benchmark attached", [c1.failed, c1.failRate, c1.orgFailRate, c1.groupsTotal], [3, 60, 12, 3]);
  eq("≥30% failing across ≥2 groups → content/assessment advice", /60% fail rate across 2 of 3 groups — review the content and assessment/.test(c1.advice), true);
  const c2 = gaps[1];
  eq("not-started rate over ASSIGNED people (3 of 4)", [c2.notStarted, c2.notStartedRate, c2.failRate], [3, 75, 0]);
  eq("≥30% not started → timing/access advice", /75% not started across 2 of 3 groups — check the assignment timing and access/.test(c2.advice), true);
  const jd = gaps[2];
  eq("journey day pending: title from the next mission, people counted once", [jd.kind, jd.title, jd.pending, /most-missed mission across 2/.test(jd.advice)], ["journey-day", "Day 5 · Pricing", 2, true]);
  eq("max cap respected", buildOrgGaps(people, bench, () => null, 0, 1).length, 1);
  eq("nobody flagged → no gaps", buildOrgGaps([learner({ userId: "z", courses: [fl("c1", "X", "in_progress")] })], bench, () => null, 0), []);
  // A person flagged on a course that is also failed above the org → coaching wording when the org rate is low.
  const coach = [learner({ userId: "q", city: "A", flags: [flag("failed", "critical", "k", "Kappa")], courses: [fl("k", "Kappa")] }), ...Array.from({ length: 4 }, (_, i) => learner({ userId: `w${i}`, city: "A", courses: [fl("k", "Kappa", "in_progress")] }))];
  eq("20% fail vs 5% org → coaching gap wording", /20% fail rate — above the org, a coaching gap/.test(buildOrgGaps(coach, new Map([["k", { failRate: 5, enrolled: 50 }]]), (l) => l.city, 1)[0].advice), true);

  // L2 groups for an L3: each L2 manager's L1 teams plus their own direct reports; the viewer never becomes a group.
  const hm = (id: string, l1: string | null = null, l2: string | null = null, l3: string | null = null, status = "active"): HierarchyMember =>
    ({ user_id: id, status, line_manager_id: l1, indirect_manager_id: l2, l3_manager_id: l3 });
  const members = [
    hm("nat"), hm("cityA", "nat"), hm("cityB", "nat"),
    hm("tlA1", "cityA", "nat"), hm("tlA2", "cityA", "nat"), hm("tlB1", "cityB", "nat"),
    hm("a1", "tlA1", "cityA", "nat"), hm("a2", "tlA1", "cityA", "nat"), hm("a3", "tlA2", "cityA", "nat"),
    hm("b1", "tlB1", "cityB", "nat"), hm("b2", "tlB1", "cityB", "nat", "inactive"),
    hm("x1", "tlX", "cityX", "nat"),
  ];
  const scope = resolveManagerScope(members, "nat");
  const ctx: ManagerContext = { scope, members, isManager: scope.level > 0, directIds: [...scope.direct], allIds: [...scope.all] };
  const groups = l2GroupsOf(ctx).map((g) => [g.id, [...g.memberIds].sort()]);
  eq("L2 groups = L2's L1 teams + L2's own direct reports; inactive and out-of-hierarchy L2s excluded", groups, [["cityA", ["a1", "a2", "a3", "tlA1", "tlA2"]], ["cityB", ["b1", "tlB1"]]]);
}

// ---------------------------------------------------------------------------
// ADR 0014 (PR 1b): the strict grant read, read strictly (ADR 0014:188)
// ---------------------------------------------------------------------------

const line = (over: Partial<CourseLine> & { courseId: string }): CourseLine => ({
  title: over.courseId, status: "not_started", officialScore: null, attempts: 0, progressPct: null, assignedAt: null, dueAt: null, overdue: false,
  startedAt: null, lastActivity: null, passedFirstTime: false, passRequiredUnmet: false, nudges: 0, openGrant: false, limitReached: false,
  completedAt: null, done: false, isAssigned: true, ...over,
});
const NOW_MS = Date.parse("2026-11-04T12:00:00.000Z");
const daysBefore = (n: number) => new Date(NOW_MS - n * 86400000).toISOString();

console.log("\nADR 0014:188 — deriveLearner computes no figure for an unreadable learner");
{
  // A failed course, a past-due path and 20 idle days: every rule would fire.
  const input = {
    courses: [line({ courseId: "c1", status: "failed", officialScore: 40, attempts: 1, done: true, completedAt: daysBefore(25), assignedAt: daysBefore(40) })],
    paths: [{ pathId: "p1", name: "P", stepsTotal: 2, stepsDone: 0, dueAt: daysBefore(5), overdue: true }],
    journeys: [{ ...journey(4), daysInPeriod: 3 }],
    lastActive: daysBefore(20),
    periodDays: 30,
    nowMs: NOW_MS,
  };
  const normal = deriveLearner(input);
  eq("control: the same input without the flag raises failed, overdue, behind and inactive", [...new Set(normal.flags.map((f) => f.kind))].sort(), ["behind", "failed", "inactive", "needs_support", "overdue"]);
  const d = deriveLearner({ ...input, historyUnavailable: true });
  eq("flagged: no completion, score, flag, risk or status; assigned, engagement and journey days as computed",
    [d.completionPct, d.completed, d.avgScore, d.assessmentsWithResult, d.passedFirstTime, d.flags, d.risk, d.status, d.completedInPeriod, d.completedInPrevPeriod, d.passedFirstTimeInPeriod, d.assigned, d.inactiveDays, d.activeLast7d, d.journeyDaysInPeriod],
    [null, 0, null, 0, 0, [], 0, "unavailable", 0, 0, 0, 1, 20, false, 3]);
}

console.log("\nADR 0014:188 — the team folds leave unreadable learners out and say how many");
{
  const readable = learner({ userId: "r", name: "Ravi", assigned: 4, completed: 2, completionPct: 50, avgScore: 80, assessmentsWithResult: 1, passedFirstTime: 1, activeLast7d: true,
    completedInPeriod: 2, passedFirstTimeInPeriod: 1, journeyDaysInPeriod: 2, completedInPrevPeriod: 1,
    courses: [line({ courseId: "c1", status: "failed", officialScore: 40 }), line({ courseId: "c2", status: "passed", officialScore: 90 })],
    flags: [flag("failed", "critical", "c1", "Alpha")] });
  const degraded = learner({ userId: "d", name: "Dev", assigned: 4, status: "unavailable", historyUnavailable: true, activeLast7d: false, journeyDaysInPeriod: 5,
    courses: [line({ courseId: "c1", status: "unavailable", historyUnavailable: true }), line({ courseId: "c2", status: "unavailable", historyUnavailable: true })],
    journeys: [journey(3)] });
  const s = teamScore([readable, degraded]);
  eq("teamScore: completion 50, assessment 80, engagement 100 over the readable learner", s.signals.map((x) => x.value), [50, 80, null, 100]);
  eq("teamScore: each note ends '· 1 not counted (history unavailable)'", s.signals.map((x) => (x.note ?? "").endsWith("· 1 not counted (history unavailable)")), [true, true, true, true]);
  eq("teamScore: unavailable 1; over two readable learners 0, notes unchanged", [s.unavailable, teamScore([readable, learner({ userId: "r2" })]).unavailable, teamScore([readable]).signals[0].note], [1, 0, "2 of 4 assigned items done"]);
  eq("teamScore: everyone unreadable → no score, the note alone", [teamScore([degraded]).score, teamScore([degraded]).signals[3].note], [null, "1 not counted (history unavailable)"]);
  const onTrack = learner({ userId: "o", name: "Zara" });
  const degradedB = learner({ userId: "d2", name: "Anil", status: "unavailable", historyUnavailable: true });
  eq("compareWorstFirst: unreadable learners after every ranked one, among themselves by name",
    [degraded, onTrack, degradedB, readable].sort(compareWorstFirst).map((l) => l.userId), ["r", "o", "d2", "d"]);
  // Numerator, denominator and journey missions alike.
  eq("periodSummary: one readable plus one unreadable learner with journey days reports the readable figures and unavailable: 1",
    periodSummary([readable, degraded], 30), { days: 30, coursesCompleted: 2, passedFirstTime: 1, assessmentsWithResult: 1, journeyMissions: 2, completionsDelta: 1, unavailable: 1 });
  eq("periodSummary: two readable learners → unavailable 0", periodSummary([readable, learner({ userId: "r2" })], 30).unavailable, 0);
  const st = buildStruggles([readable, degraded], new Map());
  const c1 = st.find((x) => x.id === "c1");
  eq("buildStruggles: the unreadable learner is in no denominator (1 of 1 failed = 100 %) and adds no journey-day row",
    [c1?.teamFailRate, st.some((x) => x.kind === "journey-day")], [100, false]);
  const gaps = buildOrgGaps([readable, degraded], new Map(), () => "Mumbai", 1);
  eq("buildOrgGaps: fail rate over the readable learner only, no journey-day gap", [gaps.find((g) => g.id === "c1")?.failRate, gaps.some((g) => g.kind === "journey-day")], [100, false]);
  const byId = new Map([readable, degraded].map((l) => [l.userId, l]));
  const card = teamCards([{ managerId: "m", managerName: "M", memberIds: ["r", "d"], isOwn: false }], byId, 30)[0];
  eq("teamCards: unavailable 1 (= score.unavailable), size keeps both, counts from flags", [card.unavailable, card.score.unavailable, card.size, card.failed, card.needsSupport, card.flagged.map((p) => p.userId)], [1, 1, 2, 1, 0, ["r"]]);
  const common = buildCommonStruggles([{ managerId: "m", managerName: "M", memberIds: ["r", "d"], isOwn: false }, { managerId: "n", managerName: "N", memberIds: [], isOwn: false }], byId);
  eq("buildCommonStruggles: no journey-day row from the unreadable learner", common.some((x) => x.kind === "journey-day"), false);
  eq("buildExceptions: an unreadable learner (no flag) adds no group", buildExceptions([degraded], { orgSlug: "acme" }), []);
  eq("matchesStatusFilter: an unreadable learner matches no status word", ["on_track", "watch", "needs_support", "failed"].map((f) => matchesStatusFilter(degraded, f)), [false, false, false, false]);

  // The read-time re-derive (lib/manager/coverage.ts loads under tsx): a
  // hidden course is dropped and the learner stays degraded.
  const lines = [line({ courseId: "c1", status: "unavailable", historyUnavailable: true, isAssigned: true }), line({ courseId: "c2", status: "unavailable", historyUnavailable: true, isAssigned: true })];
  const derived = deriveLearner({ courses: lines, paths: [], journeys: [], lastActive: daysBefore(2), periodDays: 30, nowMs: NOW_MS, historyUnavailable: true });
  const full = learner({ userId: "d", ...derived, courses: lines, historyUnavailable: true });
  const cov = applyCoverage(full, (_t, id) => id !== "c2", 30, NOW_MS);
  eq("applyCoverage: one hidden course re-derives with the flag kept, the zeros and no flag",
    [cov.hidden, cov.learner.historyUnavailable, cov.learner.status, cov.learner.completionPct, cov.learner.assigned, cov.learner.flags, cov.learner.courses.map((c) => c.courseId)],
    [1, true, "unavailable", null, 1, [], ["c1"]]);
}

/* ---------------- a recording fake of the supabase-js query builder ---------------- */

type Op = { op: string; args: unknown[] };
type Query = { table: string; ops: Op[] };
type Answer = { data?: unknown; error?: unknown };
type Row = Record<string, unknown>;

/**
 * Answers every read from `tables` with the eq / in / is filters applied (a
 * filter on a column the row does not carry is ignored); `override` may
 * answer a query first (an error, say). Records every query.
 */
function fakeDb(tables: Record<string, Row[]>, override?: (q: Query) => Answer | undefined) {
  const queries: Query[] = [];
  const client = {
    from(table: string) {
      const q: Query = { table, ops: [] };
      queries.push(q);
      const b: Record<string, unknown> = {};
      for (const op of ["select", "update", "insert", "upsert", "delete", "eq", "neq", "in", "lt", "gt", "is", "not", "or", "order", "limit", "range"]) {
        b[op] = (...args: unknown[]) => {
          q.ops.push({ op, args });
          return b;
        };
      }
      const answer = (): Answer => {
        const o = override?.(q);
        if (o) return o;
        if (q.ops.some((x) => x.op === "upsert" || x.op === "delete" || x.op === "update" || x.op === "insert")) return { data: null, error: null };
        let rows = tables[table] ?? [];
        for (const { op, args } of q.ops) {
          const [col, val] = args as [string, unknown];
          const keep = (r: Row) => !(col in r) || (op === "eq" ? r[col] === val : op === "in" ? (val as unknown[]).includes(r[col]) : op === "is" ? r[col] === val : true);
          if (op === "eq" || op === "in" || op === "is") rows = rows.filter(keep);
        }
        return { data: rows, error: null };
      };
      const settle = () => Promise.resolve({ data: null, error: null, count: null, ...answer() });
      b.maybeSingle = () => settle().then((r) => ({ ...r, data: Array.isArray(r.data) ? r.data[0] ?? null : r.data }));
      b.single = b.maybeSingle;
      b.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => settle().then(res, rej);
      return b;
    },
  };
  return { client: client as never, queries };
}
const selectOf = (q: Query) => String(q.ops.find((o) => o.op === "select")?.args[0] ?? "");
const isSnapshotRead = (q: Query) => q.table === "attempt_requests" && selectOf(q).includes("decided_by");

/** console.warn lines while `fn` runs. */
async function captureWarn<T>(fn: () => Promise<T>): Promise<{ value: T; lines: string[] }> {
  const lines: string[] = [];
  const orig = console.warn;
  console.warn = (...a: unknown[]) => { lines.push(a.map(String).join(" ")); };
  try {
    return { value: await fn(), lines };
  } finally {
    console.warn = orig;
  }
}

const iso = (s: string) => new Date(s).toISOString();
const attempt = (over: Row) => ({
  course_version_id: "v1", status: "completed", completion_status: "completed", success_status: "passed", score: 0.85,
  started_at: iso("2026-10-01T09:00:00Z"), completed_at: iso("2026-10-01T10:00:00Z"), last_activity_at: iso("2026-10-01T10:00:00Z"),
  progress_pct: 100, is_revision: false, ...over,
});
const grant = (id: string, user: string, usedAttempt: string) => ({
  id, user_id: user, course_id: "c1", status: "approved", used_attempt_id: usedAttempt, used_at: iso("2026-10-19T08:00:00Z"), expires_at: null,
  created_at: iso("2026-10-18T08:00:00Z"), decided_by: "admin-1", decided_at: iso("2026-10-18T09:00:00Z"), decision_note: "recertification", reason: "please", reissued_from: null,
});
/**
 * u1: official pass on day 0 (2026-10-21), then only revisits (a revision
 * row and a revision_visits row today). u2: passed (85 %), a granted retake
 * running (40 %), the course the only step of path p1. u3: passed (85 %),
 * then a granted retake completed and failed (60 %).
 */
function reportCardDb(override?: (q: Query) => Answer | undefined, patch?: (tables: Record<string, Row[]>) => void) {
  const tables: Record<string, Row[]> = {
    courses: [{ id: "c1", title: "Alpha", is_active: true }],
    learning_paths: [{ id: "p1", name: "Path One", is_active: true }],
    learning_path_courses: [{ path_id: "p1", course_id: "c1", step_number: 1, release_at: null }],
    organization_members: ["u1", "u2", "u3"].map((u) => ({ user_id: u, status: "active", designation: null, city: "Pune", branch: null, business_vertical: null, department: null, date_of_joining: null })),
    profiles: ["u1", "u2", "u3"].map((u) => ({ id: u, first_name: u.toUpperCase(), last_name: null, email: `${u}@example.test`, avatar_url: null })),
    course_attempts: [
      attempt({ id: "a1", user_id: "u1", score: 0.9, started_at: iso("2026-10-21T09:00:00Z"), completed_at: iso("2026-10-21T10:00:00Z"), last_activity_at: iso("2026-10-21T10:00:00Z") }),
      attempt({ id: "r1", user_id: "u1", status: "in_progress", completion_status: "in_progress", success_status: "unknown", score: null, started_at: iso("2026-11-04T08:30:00Z"), completed_at: null, last_activity_at: iso("2026-11-04T09:00:00Z"), is_revision: true }),
      attempt({ id: "a2", user_id: "u2" }),
      attempt({ id: "t2", user_id: "u2", status: "in_progress", completion_status: "in_progress", success_status: "unknown", score: null, started_at: iso("2026-11-03T08:00:00Z"), completed_at: null, last_activity_at: iso("2026-11-03T09:00:00Z"), progress_pct: 40 }),
      attempt({ id: "a3", user_id: "u3" }),
      attempt({ id: "t3", user_id: "u3", success_status: "failed", score: 0.6, started_at: iso("2026-10-20T09:00:00Z"), completed_at: iso("2026-10-20T11:00:00Z"), last_activity_at: iso("2026-10-20T11:00:00Z") }),
    ],
    course_versions: [{ id: "v1", course_id: "c1", unit_count: null }],
    course_assignments: ["u1", "u2", "u3"].map((u) => ({ course_id: "c1", assignee_type: "user", user_id: u, team_id: null, group_id: null, due_at: null, release_at: null, assigned_at: iso("2026-09-01T00:00:00Z") })),
    learning_path_assignments: [{ path_id: "p1", assignee_type: "user", user_id: "u2", team_id: null, group_id: null, due_at: iso("2026-10-25T00:00:00Z"), assigned_at: iso("2026-09-01T00:00:00Z") }],
    attempt_requests: [grant("g2", "u2", "t2"), grant("g3", "u3", "t3")],
    revision_visits: [{ id: "rv1", user_id: "u1", course_id: "c1", organization_id: "org1", launched_at: iso("2026-11-04T08:30:00Z") }],
  };
  patch?.(tables);
  return fakeDb(tables, override);
}
const NOW = new Date("2026-11-04T12:00:00.000Z");
const insightsFor = (db: ReturnType<typeof fakeDb>) =>
  computeLearnerInsights(db.client, { orgId: "org1", orgSlug: "acme", userIds: ["u1", "u2", "u3"], periodDays: 30, now: NOW });

async function insightsCases() {
  console.log("\nADR 0014 steps 7, 10, 12 — computeLearnerInsights over the fake");
  {
    const db = reportCardDb();
    const { learners } = await insightsFor(db);
    const by = new Map(learners.map((l) => [l.userId, l]));
    const u1 = by.get("u1")!, u2 = by.get("u2")!, u3 = by.get("u3")!;
    const att = db.queries.find((q) => q.table === "course_attempts")!;
    eq("the attempts select names status and is_revision", [/\bstatus\b/.test(selectOf(att)), selectOf(att).endsWith(", is_revision")], [true, true]);
    eq("u1, only revisits after day 0: last active stays day 0, inactive 14 days, the inactive flag, Last revisit carried",
      [u1.lastActive, u1.inactiveDays, u1.flags.some((f) => f.kind === "inactive"), u1.lastRevisitAt],
      [iso("2026-10-21T10:00:00Z"), 14, true, iso("2026-11-04T08:30:00Z")]);
    const l1 = u1.courses[0];
    eq("u1's line: the revision row is not an attempt and dates nothing", [l1.status, l1.attempts, l1.lastActivity, l1.officialScore, l1.retakeState, l1.previousOfficial], ["passed", 1, iso("2026-10-21T10:00:00Z"), 90, "none", null]);
    const l2 = u2.courses[0];
    eq("u2, a granted retake running: in_progress, the standing score, the retake's progress, still done",
      [l2.status, l2.officialScore, l2.progressPct, l2.done, l2.overdue, l2.retakeState], ["in_progress", 85, 40, true, false, "in_progress"]);
    eq("u2: previousOfficial is the standing result while the retake runs", l2.previousOfficial, { score: 85, status: "passed", completedAt: iso("2026-10-01T10:00:00Z") });
    eq("u2: the path step stays done (officialDone), not overdue", u2.paths.map((p) => [p.stepsDone, p.stepsTotal, p.overdue, p.historyUnavailable ?? null]), [[1, 1, false, null]]);
    const l3 = u3.courses[0];
    eq("u3, the granted retake completed and failed: its result, previousOfficial the superseded pass",
      [l3.status, l3.officialScore, l3.retakeState, l3.previousOfficial], ["failed", 60, "completed", { score: 85, status: "passed", completedAt: iso("2026-10-01T10:00:00Z") }]);
    eq("no learner is degraded on a good read", learners.map((l) => l.historyUnavailable ?? null), [null, null, null]);
    eq("the strict snapshot read: approved grants of the call's users, every course", (() => {
      const q = db.queries.find(isSnapshotRead)!;
      return [q.ops.some((o) => o.op === "eq" && o.args[0] === "status" && o.args[1] === "approved"), q.ops.some((o) => o.op === "in" && o.args[0] === "course_id")];
    })(), [true, false]);
  }
  console.log("\nthe stuck clock of a granted retake starts when the retake opens");
  {
    // u2's granted retake t2 opened yesterday (2026-11-03) and stands at 10 %.
    // Its first attempt a2 opened on 2026-10-01, 34 days ago, which must not
    // date the retake: "stuck" is 10 days open under 30 % (THRESHOLDS).
    const db = reportCardDb(undefined, (t) => {
      t.course_attempts = t.course_attempts.map((a) => (a.id === "t2" ? { ...a, progress_pct: 10 } : a));
    });
    const u2 = (await insightsFor(db)).learners.find((l) => l.userId === "u2")!;
    const line = u2.courses[0];
    eq("the line is in progress at the retake's 10 %, its startedAt the retake's own start",
      [line.status, line.retakeState, line.progressPct, line.startedAt], ["in_progress", "in_progress", 10, iso("2026-11-03T08:00:00Z")]);
    eq("…so a day into the retake there is no stuck flag (the first attempt is 34 days old)", u2.flags.some((f) => f.kind === "stuck"), false);
  }
  {
    // Control: the same retake opened 15 days ago, idle 5 days, still at 10 %.
    const db = reportCardDb(undefined, (t) => {
      t.course_attempts = t.course_attempts.map((a) =>
        a.id === "t2" ? { ...a, progress_pct: 10, started_at: iso("2026-10-20T08:00:00Z"), last_activity_at: iso("2026-10-30T09:00:00Z") } : a);
    });
    const u2 = (await insightsFor(db)).learners.find((l) => l.userId === "u2")!;
    const stuck = u2.flags.find((f) => f.kind === "stuck");
    eq("control: a retake open 15 days under 30 % is stuck, counted from the retake's start", [!!stuck, stuck?.detail], [true, "Alpha · opened 15d ago, 10%"]);
  }
  {
    // A line with no running retake keeps its earliest live attempt's start.
    const { learners } = await insightsFor(reportCardDb());
    eq("no running retake (u1, u3): startedAt is the first live attempt's start, as before",
      learners.filter((l) => l.userId !== "u2").map((l) => l.courses[0].startedAt), [iso("2026-10-21T09:00:00Z"), iso("2026-10-01T09:00:00Z")]);
  }
  {
    // 0103 not applied: the narrower-select fallback.
    const db = reportCardDb((q) => (q.table === "course_attempts" && selectOf(q).includes("is_revision") ? { data: null, error: { code: "42703", message: 'column course_attempts.is_revision does not exist' } } : undefined));
    const { learners } = await insightsFor(db);
    const selects = db.queries.filter((q) => q.table === "course_attempts").map((q) => selectOf(q).includes("is_revision"));
    eq("a database without 0103: the attempts read retries once without is_revision and the call answers", [selects, learners.length], [[true, false], 3]);
  }
  {
    // Another attempts error still throws, as fetchByIds did.
    const db = reportCardDb((q) => (q.table === "course_attempts" ? { data: null, error: { code: "57014", message: "statement timeout" } } : undefined));
    let threw = "";
    try { await insightsFor(db); } catch (e) { threw = (e as Error).message; }
    eq("another attempts error throws, never retried without the column", [threw, db.queries.filter((q) => q.table === "course_attempts").length], ["course_attempts: statement timeout", 1]);
  }

  console.log("\nADR 0014:188 — a failed grant read degrades every learner, never throws");
  {
    const db = reportCardDb((q) => (isSnapshotRead(q) ? { data: null, error: { code: "57014", message: "statement timeout" } } : undefined));
    const { value, lines } = await captureWarn(() => insightsFor(db));
    const { learners } = value;
    eq("no throw: every learner carries historyUnavailable and status 'unavailable'", learners.map((l) => [l.historyUnavailable, l.status, l.flags.length, l.completionPct, l.avgScore, l.risk]), [
      [true, "unavailable", 0, null, null, 0], [true, "unavailable", 0, null, null, 0], [true, "unavailable", 0, null, null, 0],
    ]);
    eq("every course line: 'unavailable', null score and progress, no figure from the chain", learners.flatMap((l) => l.courses.map((c) => [c.historyUnavailable, c.status, c.officialScore, c.progressPct, c.done, c.completedAt, c.overdue, c.openGrant, c.limitReached, c.passedFirstTime, c.retakeState ?? null])), [
      [true, "unavailable", null, null, false, null, false, false, false, false, null],
      [true, "unavailable", null, null, false, null, false, false, false, false, null],
      [true, "unavailable", null, null, false, null, false, false, false, false, null],
    ]);
    eq("the fields that need no grant stay: attempts and last activity", learners.map((l) => [l.courses[0].attempts, l.courses[0].lastActivity]), [
      [1, iso("2026-10-21T10:00:00Z")], [2, iso("2026-11-03T09:00:00Z")], [2, iso("2026-10-20T11:00:00Z")],
    ]);
    eq("every path line carries the flag, no step count and no overdue (its due date is past)", learners.flatMap((l) => l.paths.map((p) => [p.historyUnavailable, p.stepsDone, p.overdue])), [[true, 0, false]]);
    eq("one log line, the event and the org, no learner id", lines.map((x) => JSON.parse(x)), [{ event: "report_card_grants_unreadable", org_id: "org1", code: "57014" }]);
    eq("Last active stays person-level (needs no grant)", learners.map((l) => l.lastActive), [iso("2026-10-21T10:00:00Z"), iso("2026-11-03T09:00:00Z"), iso("2026-10-20T11:00:00Z")]);
  }
  {
    // A client-level throw on that one read degrades too (the precompute never fails on a grant read).
    const db = reportCardDb((q) => { if (isSnapshotRead(q)) throw new Error("fetch failed"); return undefined; });
    const { value, lines } = await captureWarn(() => insightsFor(db));
    eq("a thrown client error on the grant read degrades, logged with no code", [value.learners.every((l) => l.historyUnavailable === true), lines.map((x) => JSON.parse(x).code)], [true, [null]]);
  }
  {
    // A failed visits read: Last revisit absent, nothing else changes.
    const db = reportCardDb((q) => (q.table === "revision_visits" ? { data: null, error: { code: "57014", message: "timeout" } } : undefined));
    const { value } = await captureWarn(() => insightsFor(db));
    eq("a failed revision_visits read: lastRevisitAt null, the learner still readable", [value.learners[0].lastRevisitAt, value.learners[0].historyUnavailable ?? null], [null, null]);
  }

  console.log("\nADR 0014:188 — the precompute caches no degraded batch");
  {
    const one = (override?: (q: Query) => Answer | undefined) => {
      const db = reportCardDb(override);
      // refreshOrgCache lists the active members first: one learner.
      return { db, run: () => refreshOrgCache(db.client, { id: "org1", slug: "acme" }) };
    };
    const healthy = one((q) => (q.table === "organization_members" && selectOf(q) === "user_id" ? { data: [{ user_id: "u2" }], error: null } : undefined));
    const ok = await healthy.run();
    const upserts = healthy.db.queries.filter((q) => q.table === "report_card_cache" && q.ops.some((o) => o.op === "upsert"));
    eq("control: a readable batch is upserted (four period rows)", [ok, upserts.length, (upserts[0]?.ops.find((o) => o.op === "upsert")?.args[0] as unknown[] | undefined)?.length], [{ learners: 1, batches: 1, pending: 0, skipped_unreadable: 0 }, 1, 4]);
    const failing = one((q) =>
      q.table === "organization_members" && selectOf(q) === "user_id" ? { data: [{ user_id: "u2" }], error: null }
        : isSnapshotRead(q) ? { data: null, error: { code: "57014", message: "statement timeout" } } : undefined);
    const { value: bad, lines } = await captureWarn(() => failing.run());
    eq("a degraded batch: no upsert, counted as skipped_unreadable and pending", [bad, failing.db.queries.some((q) => q.table === "report_card_cache" && q.ops.some((o) => o.op === "upsert"))], [{ learners: 0, batches: 0, pending: 1, skipped_unreadable: 1 }, false]);
    eq("the refresh logs once that it skipped", lines.map((x) => JSON.parse(x).event), ["report_card_grants_unreadable", "report_card_cache_skipped_unreadable"]);
  }
}

// ---------------------------------------------------------------------------
// Source checks (the PR 1a style): the reminder action imports the cookie
// client, and the views are .tsx with next/* imports, so neither runs here.
// ---------------------------------------------------------------------------

const root = path.resolve(__dirname, "../..");
const read = (f: string) => fs.readFileSync(path.join(root, f), "utf8");
/** Line and block comments blanked, strings kept. */
const code = (f: string) => read(f).replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " ")).replace(/(^|[^:"'`\\])\/\/[^\n]*/g, "$1");

function sourceCases() {
  console.log("\nADR 0014:188 — the reminder action skips an unreadable line");
  {
    const src = code("lib/manager/actions.ts");
    const branch = src.slice(src.indexOf('if (target === "course") {'), src.indexOf("// Journey: the learner's ACTIVE enrollment"));
    const at = branch.indexOf('reason: "records could not be read; try again"');
    eq("the course branch skips on line.historyUnavailable / status 'unavailable' with its reason", [
      /if \(line\.historyUnavailable \|\| line\.status === "unavailable"\) \{\s*results\.push\(\{ userId: uid, status: "skipped", reason: "records could not be read; try again" \}\);\s*continue;\s*\}/.test(branch),
    ], [true]);
    eq("…after the !line check and before the completed skip, notifyBackground( and the reminder_state upsert", [
      at > branch.indexOf("if (!line)"),
      at < branch.indexOf('line.status === "completed"'),
      at < branch.indexOf("notifyBackground("),
      at < branch.indexOf('.from("reminder_state").upsert('),
      branch.indexOf('.from("reminder_state").upsert(') > 0,
    ], [true, true, true, true, true]);
  }

  console.log("\nADR 0014:188 — the views withhold the four reassurances and show the count");
  const TP = "app/[org]/(learner)/team-performance";
  /** The reassurance sits in the else of a historyUnavailable test whose then-branch names "History unavailable for". */
  const guarded = (src: string, reassurance: string) => {
    const at = src.indexOf(reassurance);
    const gate = src.lastIndexOf("historyUnavailable", at);
    const text = src.lastIndexOf("History unavailable for", at);
    return at > 0 && gate > 0 && text > gate && at - gate < 400;
  };
  const views: Array<[string, string]> = [
    [`${TP}/_components/l1-view.tsx`, "Nothing needs attention right now — everyone is on track."],
    [`${TP}/_components/l2-view.tsx`, "Every team is on track."],
    [`${TP}/_components/l3-view.tsx`, "No module or journey day is holding the organisation back right now."],
    [`${TP}/[userId]/page.tsx`, "Nothing is flagged — nothing to chase right now."],
  ];
  for (const [f, reassurance] of views) {
    const src = code(f);
    eq(`${f}: the reassurance is guarded by a historyUnavailable test and replaced by "History unavailable for …"`, guarded(src, reassurance), true);
  }
  eq("the learner and plural wording", [
    /History unavailable for \{unreadableN\} \{unreadableN === 1 \? "learner" : "learners"\}\. Please reload\./.test(code(`${TP}/_components/l1-view.tsx`)),
    /History unavailable for \{unreadableN\} \{unreadableN === 1 \? "learner" : "learners"\}\. Please reload\./.test(code(`${TP}/_components/l2-view.tsx`)),
    /History unavailable for \{unreadableN\} \{unreadableN === 1 \? "learner" : "learners"\}\. Please reload\./.test(code(`${TP}/_components/l3-view.tsx`)),
    code(`${TP}/[userId]/page.tsx`).includes('"History unavailable for 1 learner. Please reload."'),
  ], [true, true, true, true]);
  /** Visible lines naming "not counted (history unavailable)", none inside a title= attribute. */
  const visible = (src: string) => src.split("\n").filter((ln) => ln.includes("not counted (history unavailable)"));
  const l1 = code(`${TP}/_components/l1-view.tsx`), l2 = code(`${TP}/_components/l2-view.tsx`), l3 = code(`${TP}/_components/l3-view.tsx`);
  eq("the score cards and the period card print the count as text, not only as a title", [
    visible(l1).length, visible(l1).some((ln) => /title=/.test(ln)), visible(l2).length, visible(l2).some((ln) => /title=/.test(ln)), visible(l3).length, visible(l3).some((ln) => /title=/.test(ln)),
  ], [2, false, 1, false, 1, false]);
  eq("…each from its own count, before the card's footnote", [
    /\{score\.unavailable > 0 && <p[^>]*>\{score\.unavailable\} not counted \(history unavailable\)<\/p>\}/.test(l1) && l1.indexOf("score.unavailable > 0") < l1.indexOf("Weights 35"),
    /\{summary\.unavailable > 0 && <p[^>]*>\{summary\.unavailable\} not counted \(history unavailable\)<\/p>\}/.test(l1) && l1.indexOf("summary.unavailable > 0") < l1.lastIndexOf("As of {p.today}"),
    /\{group\.unavailable > 0 && <p[^>]*>\{group\.unavailable\} not counted \(history unavailable\)<\/p>\}/.test(l2),
    /\{org\.unavailable > 0 && <p[^>]*>\{org\.unavailable\} not counted \(history unavailable\)<\/p>\}/.test(l3),
  ], [true, true, true, true]);
  eq("Active this week folds over the readable learners, both halves", /\{readable\.filter\(\(l\) => l\.activeLast7d\)\.length\} \/ \{readable\.length\}/.test(l1) && /const readable = learners\.filter\(\(l\) => !l\.historyUnavailable\);/.test(l1), true);
  eq("the team rows and the compare cards print 'N not counted' from TeamCard.unavailable", [
    /\{c\.unavailable > 0 && <span[^>]*>\{c\.unavailable\} not counted<\/span>\}/.test(l2),
    /\{c\.unavailable > 0 && <span[^>]*>\{c\.unavailable\} not counted<\/span>\}/.test(l3) && /notCountedNote\(c\.unavailable\)/.test(l3),
    /c\.unavailable > 0 \? ` · \$\{c\.unavailable\} not counted` : ""/.test(code(`${TP}/compare/page.tsx`)),
  ], [true, true, true]);

  console.log("\nADR 0014:188 — the employee report prints no figure for an unreadable learner");
  {
    const src = code(`${TP}/[userId]/page.tsx`);
    eq("the course row: the title and one cell spanning the six others with the text", /c\.historyUnavailable \? \([\s\S]{0,200}<td className="px-5 py-2\.5 font-medium">\{c\.title\}<\/td>\s*<td colSpan=\{6\}[^>]*>\{UNAVAILABLE_TEXT\}<\/td>\s*<\/tr>/.test(src), true);
    eq("the Completion and Avg score KPIs read the text as their sub", (src.match(/sub=\{unavailable \? UNAVAILABLE_TEXT : /g) ?? []).length, 2);
    eq("the path list prints the text in place of the step count", /p\.historyUnavailable \? \(\s*<span[^>]*>\{UNAVAILABLE_TEXT\}<\/span>/.test(src), true);
    eq("the text is the ADR's", /const UNAVAILABLE_TEXT = "History unavailable\. Please reload\.";/.test(src), true);
    eq("Last revisit beside the inactive flag (ADR 0014:199)", /f\.kind === "inactive" && l\.lastRevisitAt \? `\$\{f\.detail\} · Last revisit: \$\{relativeDays\(l\.lastRevisitAt, nowMs\)\}`/.test(src), true);
    eq("the retake's state beside the replaced result, as the admin row", [src.includes("→ retake in progress"), /c\.retakeState === "completed"/.test(src)], [true, true]);
  }
}

insightsCases()
  .then(sourceCases)
  .then(() => {
    console.log(`\n${pass} passed, ${fail} failed`);
    if (fail > 0) process.exit(1);
  })
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });

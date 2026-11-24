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
 * ADR 0029, note of 2026-11-25, part 1: the manager's course reminder reads
 * its own lines (readCourseReminderLines, in lib/manager/insights.ts beside
 * the Report Card's reader). Over the same fake, for every world of the
 * note (a person's, a team's, a group's and the organisation's rows, the
 * paths, an inactive course, every kind of attempt, a stored rule that is
 * not the default), it answers what computeLearnerInsights answers with the
 * course's lens, learner by learner: a line or none, and its status. Its
 * calls are pinned for each world of the note's sums, for 5 and 50 learners
 * in an organisation of 100 and of 2,500, and every read is strict (the
 * strict cases of stage 2 moved here from computeLearnerInsights's option).
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
import { computeLearnerInsights, readCourseReminderLines } from "../../lib/manager/insights";
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
 * Answers every read from `tables` with the eq / neq / in / is filters
 * applied (a filter on a column the row does not carry is ignored), then, as
 * the server does, at most 1,000 rows: the `range` asked, or the first 1,000
 * (in the tables' own order, a stable one). `override` may answer a query
 * first (an error, say). Records every query.
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
          const keep = (r: Row) => !(col in r) || (op === "eq" ? r[col] === val : op === "neq" ? r[col] !== val : op === "in" ? (val as unknown[]).includes(r[col]) : op === "is" ? r[col] === val : true);
          if (op === "eq" || op === "neq" || op === "in" || op === "is") rows = rows.filter(keep);
        }
        // The server's row cap: the page asked, never more than 1,000 rows.
        const range = q.ops.find((x) => x.op === "range");
        const [from, to] = range ? (range.args as [number, number]) : [0, 999];
        return { data: rows.slice(from, Math.min(to + 1, from + 1000)), error: null };
      };
      const settle = () => Promise.resolve({ data: null, error: null, count: null, ...answer() });
      b.maybeSingle = () => settle().then((r) => ({ ...r, data: Array.isArray(r.data) ? r.data[0] ?? null : r.data }));
      b.single = b.maybeSingle;
      b.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => settle().then(res, rej);
      return b;
    },
    /** A database function, recorded as the table "rpc/<name>": no rows unless `tables` or `override` say otherwise. */
    rpc(name: string, args: unknown) {
      const q: Query = { table: `rpc/${name}`, ops: [{ op: "rpc", args: [args] }] };
      queries.push(q);
      return Promise.resolve({ data: tables[q.table] ?? [], error: null, ...(override?.(q) ?? {}) });
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

  await reminderReadCases();
}

/* ---------------- the reminder's own read (ADR 0029, note of 2026-11-25, part 1) ---------------- */

/** A case that throws (the reader missing, say) is one failed case, and the file goes on. */
async function guarded(n: string, fn: () => Promise<void>) {
  try {
    await fn();
  } catch (e) {
    fail++;
    console.log(`  ✗ ${n} — threw: ${e instanceof Error ? e.message : String(e)}`);
  }
}
type Tables = Record<string, Row[]>;
const FUTURE = iso("2026-12-01T00:00:00Z");
const PAST = iso("2026-10-01T00:00:00Z");
let seq = 0;
const nextId = (p: string) => `${p}-${String(++seq).padStart(4, "0")}`;
/** An active member of org1 with every field a group's rule reads. */
const member = (u: string, over: Row = {}): Row => ({
  organization_id: "org1", user_id: u, status: "active", designation: null, job_role: null, city: "Pune", state: null,
  business_vertical: "V1", branch: null, department: null, line_manager_id: null, date_of_joining: null, ...over,
});
/** A course_assignments row of c1, released, for nobody until `over` says whom. */
const courseRow = (over: Row): Row => ({
  id: nextId("ca"), organization_id: "org1", course_id: "c1", assignee_type: "user", user_id: null, team_id: null, group_id: null,
  due_at: null, release_at: null, assigned_at: PAST, ...over,
});
const ownRow = (u: string, over: Row = {}) => courseRow({ assignee_type: "user", user_id: u, ...over });
/** A learning_path_assignments row. */
const pathRow = (path: string, over: Row): Row => ({
  id: nextId("pa"), organization_id: "org1", path_id: path, assignee_type: "user", user_id: null, team_id: null, group_id: null,
  due_at: null, assigned_at: PAST, ...over,
});
/** A learner's row on c1's version v1, in org1, individual (not a preview). */
const att = (u: string, over: Row = {}): Row =>
  attempt({ id: nextId(`att-${u}`), user_id: u, organization_id: "org1", context_kind: "individual", course_version_id: "v1", ...over });
const inProgress: Row = { status: "in_progress", completion_status: "in_progress", success_status: "unknown", score: null, completed_at: null };
const failedRow: Row = { success_status: "failed", score: 0.4 };
const grantOf = (u: string, usedAttempt: string): Row => ({ ...grant(nextId("g"), u, usedAttempt), organization_id: "org1" });
const group = (id: string, type: "static" | "dynamic", rules: Row = {}, active = true): Row =>
  ({ id, organization_id: "org1", name: id, group_type: type, rules, is_active: active });

/** The reminder's world: org1, the course c1 (version v1) and c2 (version v2), `users` as active members, nothing assigned. */
function readerDb(users: string[], patch: (t: Tables) => void, override?: (q: Query) => Answer | undefined, others = 0) {
  const t: Tables = {
    courses: [{ id: "c1", organization_id: "org1", title: "Alpha", is_active: true }, { id: "c2", organization_id: "org1", title: "Beta", is_active: true }],
    course_versions: [{ id: "v1", course_id: "c1", unit_count: null }, { id: "v2", course_id: "c2", unit_count: null }],
    learning_paths: [], learning_path_courses: [], learning_path_assignments: [],
    course_assignments: [], team_members: [], org_groups: [], org_group_members: [],
    organization_members: [...users.map((u) => member(u)), ...Array.from({ length: others }, (_, i) => member(`x${i + 1}`))],
    profiles: users.map((u) => ({ id: u, first_name: u.toUpperCase(), last_name: null, email: `${u}@example.test`, avatar_url: null })),
    course_attempts: [], attempt_requests: [], revision_visits: [],
  };
  patch(t);
  return { db: fakeDb(t, override), tables: t };
}
const usersOf = (n: number) => Array.from({ length: n }, (_, i) => `u${i + 1}`);
/**
 * c1 assigned to the dynamic group g6, whose rule is the team t6: 1,500
 * other active members (m1 to m1500) in it first, then u1 to u3. A named u4
 * is in no team. Past the server's 1,000-row cap, a team read that is not
 * paged loses u1 to u3.
 */
const bigTeam = (t: Tables) => {
  t.org_groups.push(group("g6", "dynamic", { team_ids: ["t6"] }));
  t.course_assignments.push(courseRow({ assignee_type: "group", group_id: "g6" }));
  for (let i = 1; i <= 1_500; i++) {
    t.organization_members.push(member(`m${i}`));
    t.team_members.push({ team_id: "t6", user_id: `m${i}` });
  }
  t.team_members.push(...["u1", "u2", "u3"].map((u) => ({ team_id: "t6", user_id: u })));
};

/** The Report Card's line for c1 (its status, or null for no line), learner by learner, and the reminder's. */
async function bothReaders(users: string[], db: ReturnType<typeof fakeDb>, courseActive: boolean) {
  const card = await captureWarn(() => computeLearnerInsights(db.client, { orgId: "org1", orgSlug: "acme", userIds: users, periodDays: 30, content: "course:c1", now: NOW }));
  const cardLines = users.map((u) => card.value.learners.find((l) => l.userId === u)?.courses.find((c) => c.courseId === "c1")?.status ?? null);
  const lines = await readCourseReminderLines(db.client, { orgId: "org1", courseId: "c1", courseActive, userIds: users, now: NOW });
  return { card: cardLines, reader: users.map((u) => lines.get(u)?.status ?? null) };
}

async function reminderReadCases() {
  console.log("\nADR 0029 (note of 2026-11-25, part 1) — the reminder's read answers what the Report Card answers, learner by learner");
  type World = { label: string; users: string[]; patch: (t: Tables) => void; card: Array<string | null>; courseActive?: boolean };
  const worlds: World[] = [
    { label: "a row of their own: released, not yet released, released in the past", users: usersOf(3),
      patch: (t) => t.course_assignments.push(ownRow("u1"), ownRow("u2", { release_at: FUTURE }), ownRow("u3", { release_at: PAST })),
      card: ["not_started", null, "not_started"] },
    { label: "the organisation's row", users: usersOf(2),
      patch: (t) => t.course_assignments.push(courseRow({ assignee_type: "org" })), card: ["not_started", "not_started"] },
    { label: "the organisation's row, not yet released", users: usersOf(2),
      patch: (t) => t.course_assignments.push(courseRow({ assignee_type: "org", release_at: FUTURE })), card: [null, null] },
    { label: "a team's row: a member and a non-member", users: usersOf(2),
      patch: (t) => {
        t.course_assignments.push(courseRow({ assignee_type: "team", team_id: "t1" }));
        t.team_members.push({ team_id: "t1", user_id: "u1" }, { team_id: "t1", user_id: "x-not-named" });
      }, card: ["not_started", null] },
    { label: "a static group: a member, a member who is not active, an inactive group's member, a non-member", users: usersOf(4),
      patch: (t) => {
        t.org_groups.push(group("g1", "static"), group("g2", "static", {}, false));
        t.course_assignments.push(courseRow({ assignee_type: "group", group_id: "g1" }), courseRow({ assignee_type: "group", group_id: "g2" }));
        t.org_group_members.push({ group_id: "g1", user_id: "u1" }, { group_id: "g1", user_id: "u2" }, { group_id: "g2", user_id: "u3" });
        t.organization_members = t.organization_members.map((m) => (m.user_id === "u2" ? { ...m, status: "inactive" } : m));
      }, card: ["not_started", "not_started", null, null] },
    { label: "a dynamic group by a field rule: a member, a non-member, a member who is not active", users: usersOf(3),
      patch: (t) => {
        t.org_groups.push(group("g3", "dynamic", { verticals: ["V9"] }));
        t.course_assignments.push(courseRow({ assignee_type: "group", group_id: "g3" }));
        t.organization_members = t.organization_members.map((m) =>
          m.user_id === "u1" ? { ...m, business_vertical: "V9" } : m.user_id === "u3" ? { ...m, business_vertical: "V9", status: "inactive" } : m);
      }, card: ["not_started", null, null] },
    { label: "a dynamic group by a team rule, and an inactive dynamic group that holds everybody", users: usersOf(3),
      patch: (t) => {
        t.org_groups.push(group("g4", "dynamic", { team_ids: ["t2"] }), group("g5", "dynamic", { verticals: ["V1"] }, false));
        t.course_assignments.push(courseRow({ assignee_type: "group", group_id: "g4" }), courseRow({ assignee_type: "group", group_id: "g5" }));
        t.team_members.push({ team_id: "t2", user_id: "u1" }, { team_id: "t2", user_id: "u3" });
        t.organization_members = t.organization_members.map((m) => (m.user_id === "u3" ? { ...m, status: "inactive" } : m));
      }, card: ["not_started", null, null] },
    { label: "a path: active with a released step, assigned to a person, a team, a static and a dynamic group; an unreleased step; an inactive path", users: usersOf(6),
      patch: (t) => {
        t.learning_paths.push({ id: "p1", organization_id: "org1", name: "P1", is_active: true }, { id: "p2", organization_id: "org1", name: "P2", is_active: true }, { id: "p3", organization_id: "org1", name: "P3", is_active: false });
        t.learning_path_courses.push(
          { path_id: "p1", course_id: "c1", step_number: 1, release_at: null },
          { path_id: "p2", course_id: "c1", step_number: 1, release_at: FUTURE },
          { path_id: "p3", course_id: "c1", step_number: 1, release_at: null },
        );
        t.org_groups.push(group("g1", "static"), group("g3", "dynamic", { verticals: ["V9"] }));
        t.org_group_members.push({ group_id: "g1", user_id: "u3" });
        t.team_members.push({ team_id: "t1", user_id: "u2" });
        t.organization_members = t.organization_members.map((m) => (m.user_id === "u4" ? { ...m, business_vertical: "V9" } : m));
        t.learning_path_assignments.push(
          pathRow("p1", { assignee_type: "user", user_id: "u1" }), pathRow("p1", { assignee_type: "team", team_id: "t1" }),
          pathRow("p1", { assignee_type: "group", group_id: "g1" }), pathRow("p1", { assignee_type: "group", group_id: "g3" }),
          pathRow("p2", { assignee_type: "user", user_id: "u5" }), pathRow("p3", { assignee_type: "user", user_id: "u6" }),
        );
      }, card: ["not_started", "not_started", "not_started", "not_started", null, null] },
    { label: "a path assigned to the organisation", users: usersOf(2),
      patch: (t) => {
        t.learning_paths.push({ id: "p1", organization_id: "org1", name: "P1", is_active: true });
        t.learning_path_courses.push({ path_id: "p1", course_id: "c1", step_number: 1, release_at: PAST });
        t.learning_path_assignments.push(pathRow("p1", { assignee_type: "org" }));
      }, card: ["not_started", "not_started"] },
    { label: "an inactive course: its own row, a team's row and a path give nothing; rows still give a line", users: usersOf(5), courseActive: false,
      patch: (t) => {
        t.courses = t.courses.map((c) => (c.id === "c1" ? { ...c, is_active: false } : c));
        t.course_assignments.push(ownRow("u1"), courseRow({ assignee_type: "team", team_id: "t1" }));
        t.team_members.push({ team_id: "t1", user_id: "u4" });
        t.course_attempts.push(att("u2", inProgress), att("u3"));
        t.learning_paths.push({ id: "p1", organization_id: "org1", name: "P1", is_active: true });
        t.learning_path_courses.push({ path_id: "p1", course_id: "c1", step_number: 1, release_at: null });
        t.learning_path_assignments.push(pathRow("p1", { assignee_type: "user", user_id: "u5" }));
      }, card: [null, "in_progress", "passed", null, null] },
  ];
  /**
   * The attempts, with no assignment row (a line from the rows alone) and
   * with a row of their own for everybody: none; in progress; passed;
   * failed; completed with no verdict; abandoned only; a revision visit
   * only; a preview only; passed with a granted retake running; passed with
   * a granted retake completed and failed; passed with a granted retake that
   * was reset; a row on another course's version.
   */
  const attempts = (t: Tables) => {
    t.course_attempts.push(
      att("u2", inProgress),
      att("u3"),
      att("u4", failedRow),
      att("u5", { success_status: "unknown", score: null }),
      att("u6", { ...inProgress, status: "abandoned" }),
      att("u7", { ...inProgress, is_revision: true }),
      att("u8", { context_kind: "preview" }),
      att("u9"), att("u9", { ...inProgress, id: "t9", started_at: iso("2026-11-03T08:00:00Z") }),
      att("u10"), att("u10", { ...failedRow, id: "t10", started_at: iso("2026-10-20T09:00:00Z"), completed_at: iso("2026-10-20T11:00:00Z") }),
      att("u11"), att("u11", { ...inProgress, id: "t11", status: "abandoned", started_at: iso("2026-10-20T09:00:00Z") }),
      att("u12", { course_version_id: "v2" }),
    );
    t.attempt_requests.push(grantOf("u9", "t9"), grantOf("u10", "t10"), grantOf("u11", "t11"));
  };
  worlds.push(
    { label: "the attempts, with no assignment row", users: usersOf(12), patch: attempts,
      card: [null, "in_progress", "passed", "failed", "completed", "not_started", "not_started", null, "in_progress", "failed", "passed", null] },
    { label: "the same attempts, each learner with a row of their own", users: usersOf(12),
      patch: (t) => { attempts(t); for (const u of usersOf(12)) t.course_assignments.push(ownRow(u)); },
      card: ["not_started", "in_progress", "passed", "failed", "completed", "not_started", "not_started", "not_started", "in_progress", "failed", "passed", "not_started"] },
    // A stored rule that is not the default: three scored attempts, the best
    // official. normalizePolicy clamps it to the default (one attempt, the
    // first), so the Report Card reads the first attempt's fail, as the
    // reminder does without reading the rule. If the clamp is ever lifted,
    // the Report Card reads the second attempt's pass and this case goes red.
    { label: "a stored rule that is not the default (three attempts, the best official), clamped", users: usersOf(1),
      patch: (t) => {
        t.course_assignments.push(ownRow("u1"));
        t.course_attempts.push(
          att("u1", { ...failedRow, started_at: iso("2026-10-01T09:00:00Z"), completed_at: iso("2026-10-01T10:00:00Z") }),
          att("u1", { score: 0.95, started_at: iso("2026-10-05T09:00:00Z"), completed_at: iso("2026-10-05T10:00:00Z") }),
        );
        t["rpc/effective_attempt_policies"] = [{ course_id: "c1", max_scored_attempts: 3, official_basis: "best", official_attempt_number: null, retain_first_attempt: true, after_limit: "practice", source: "course", source_id: "c1" }];
      }, card: ["failed"] },
  );
  // Past the server's 1,000-row cap: the fake answers at most 1,000 rows a
  // call, so a read that is not paged loses the rows after them.
  worlds.push(
    { label: "a dynamic group whose team has 1,500 other members before the named learners (past the server's 1,000-row cap), and a named learner in no team", users: usersOf(4),
      patch: bigTeam, card: ["not_started", "not_started", "not_started", null] },
    { label: "an organisation with 1,200 other courses and 1,200 other paths before the course and its path (past the cap): a row of their own, a path", users: usersOf(2),
      patch: (t) => {
        t.courses = [...Array.from({ length: 1_200 }, (_, i) => ({ id: `cx${i + 1}`, organization_id: "org1", title: `Course ${i + 1}`, is_active: true })), ...t.courses];
        t.learning_paths.push(...Array.from({ length: 1_200 }, (_, i) => ({ id: `px${i + 1}`, organization_id: "org1", name: `Path ${i + 1}`, is_active: true })));
        t.learning_paths.push({ id: "p1", organization_id: "org1", name: "P1", is_active: true });
        t.learning_path_courses.push({ path_id: "p1", course_id: "c1", step_number: 1, release_at: null });
        t.course_assignments.push(ownRow("u1"));
        t.learning_path_assignments.push(pathRow("p1", { assignee_type: "user", user_id: "u2" }));
      }, card: ["not_started", "not_started"] },
  );
  for (const w of worlds) {
    await guarded(w.label, async () => {
      const { db } = readerDb(w.users, w.patch);
      const r = await bothReaders(w.users, db, w.courseActive ?? true);
      eq(`${w.label}: the Report Card's lines (the world tests what it names)`, r.card, w.card);
      eq("…the reminder's read: the same line, or none, and the same status, for every learner", r.reader, r.card);
    });
  }

  console.log("\nthe Report Card reads a dynamic group's team in pages (lib/org/groups.ts resolveGroupMembers), and a failed read still reads as no team members");
  {
    const users = usersOf(5);
    /** bigTeam, and u5's row first, so the first page holds a named learner. */
    const patch = (t: Tables) => {
      bigTeam(t);
      t.team_members.unshift({ team_id: "t6", user_id: "u5" });
    };
    const card = async (override?: (q: Query) => Answer | undefined, extra?: (t: Tables) => void) => {
      const { db } = readerDb(users, (t) => { patch(t); extra?.(t); }, override);
      const { value } = await captureWarn(() => computeLearnerInsights(db.client, { orgId: "org1", orgSlug: "acme", userIds: users, periodDays: 30, content: "course:c1", now: NOW }));
      return { db, lines: users.map((u) => value.learners.find((l) => l.userId === u)?.courses.find((c) => c.courseId === "c1")?.status ?? null) };
    };
    const shape = (q: Query) => [
      q.ops.filter((o) => o.op === "order").map((o) => o.args[0]),
      q.ops.filter((o) => o.op === "range").map((o) => o.args),
      q.ops.filter((o) => o.op === "in").map((o) => [o.args[0], (o.args[1] as unknown[]).length]),
    ];
    await guarded("the team read's calls", async () => {
      const { db, lines } = await card();
      eq("control: every named member of the team has a line, the learner in no team none", lines, ["not_started", "not_started", "not_started", null, "not_started"]);
      eq("1,504 rows: two calls, pages of 1,000 in the key's order (team_id, user_id), the rule's one team in the list",
        db.queries.filter((q) => q.table === "team_members").map(shape), [
          [["team_id", "user_id"], [[0, 999]], [["team_id", 1]]],
          [["team_id", "user_id"], [[1000, 1999]], [["team_id", 1]]],
        ]);
      // A rule naming 160 teams (parseGroupRules keeps 200): two lists, of 150 and of 10 ids.
      const many = await card(undefined, (t) => {
        const g = t.org_groups.find((x) => x.id === "g6")!;
        g.rules = { team_ids: ["t6", ...Array.from({ length: 159 }, (_, i) => `te${i + 1}`)] };
      });
      eq("a rule of 160 teams: lists of at most 150 ids (150, then 10), the same lines",
        [many.db.queries.filter((q) => q.table === "team_members").map((q) => (q.ops.find((o) => o.op === "in")!.args[1] as unknown[]).length), many.lines],
        [[150, 150, 10], ["not_started", "not_started", "not_started", null, "not_started"]]);
    });
    await guarded("the team read fails", async () => {
      const BOOM = { data: null, error: { code: "XX000", message: "stub read failure" } };
      const first = await card((q) => (q.table === "team_members" ? BOOM : undefined));
      eq("the first call fails: no throw, and the team holds nobody (as today's failed read)", first.lines, [null, null, null, null, null]);
      const later = await card((q) => (q.table === "team_members" && q.ops.some((o) => o.op === "range" && o.args[0] === 1000) ? BOOM : undefined));
      eq("a later page fails: no throw, and the team holds nobody, u5 of the first page too (any failed call reads as today's failed read)", later.lines, [null, null, null, null, null]);
      const noList = await card((q) => (q.table === "team_members" ? { data: null, error: null } : undefined));
      eq("an answer that is not a list: the team holds nobody, as today", noList.lines, [null, null, null, null, null]);
    });
  }

  console.log("\nADR 0029 (note of 2026-11-25, part 1, points 6 and 7) — the reminder's read: its calls, whatever the team's or the organisation's size");
  /** Every learner a row of their own (c), unless the world says otherwise. */
  type CallWorld = { label: string; calls: number; patch: (t: Tables, users: string[]) => void; courseActive?: boolean };
  const pathOf = (t: Tables, released = true) => {
    t.learning_paths.push({ id: "p1", organization_id: "org1", name: "P1", is_active: true });
    t.learning_path_courses.push({ path_id: "p1", course_id: "c1", step_number: 1, release_at: released ? null : FUTURE });
  };
  const callWorlds: CallWorld[] = [
    { label: "everybody has opened it, nobody has finished it: the versions and the rows", calls: 2,
      patch: (t, us) => { for (const u of us) { t.course_attempts.push(att(u, inProgress)); t.course_assignments.push(ownRow(u)); } } },
    { label: "each by a row of their own, nobody has opened it: the versions, the rows, their own rows", calls: 3,
      patch: (t, us) => { for (const u of us) t.course_assignments.push(ownRow(u)); } },
    { label: "the same, and somebody has finished it: and their grants", calls: 4,
      patch: (t, us) => { for (const u of us) t.course_assignments.push(ownRow(u)); t.course_attempts.push(att(us[0])); } },
    { label: "only through a dynamic group, the course on no path: a to e, the groups, the member fields", calls: 7,
      patch: (t) => {
        t.org_groups.push(group("g3", "dynamic", { verticals: ["V1"] }));
        t.course_assignments.push(courseRow({ assignee_type: "group", group_id: "g3" }));
      } },
    { label: "only through a path a dynamic group is assigned: a to h, the groups, the member fields", calls: 10,
      patch: (t) => {
        pathOf(t);
        t.org_groups.push(group("g3", "dynamic", { verticals: ["V1"] }));
        t.learning_path_assignments.push(pathRow("p1", { assignee_type: "group", group_id: "g3" }));
      } },
    { label: "every step: a team, a static and a dynamic group with a team rule, a path, a finished learner", calls: 13,
      patch: (t, us) => {
        pathOf(t);
        t.course_attempts.push(att(us[0]));
        t.course_assignments.push(ownRow(us[1]), courseRow({ assignee_type: "team", team_id: "t1" }), courseRow({ assignee_type: "group", group_id: "g1" }), courseRow({ assignee_type: "group", group_id: "g3" }));
        t.team_members.push({ team_id: "t1", user_id: us[2] }, { team_id: "t9", user_id: us[3] });
        t.org_groups.push(group("g1", "static"), group("g3", "dynamic", { verticals: ["V9"], team_ids: ["t9"] }));
        t.org_group_members.push({ group_id: "g1", user_id: us[4] });
        t.organization_members = t.organization_members.map((m) => (m.user_id === us[3] ? { ...m, business_vertical: "V9" } : m));
        t.learning_path_assignments.push(pathRow("p1", { assignee_type: "user", user_id: us[4] }), pathRow("p1", { assignee_type: "team", team_id: "t1" }));
      } },
    { label: "an inactive course: the versions and the rows only", calls: 2, courseActive: false,
      patch: (t, us) => {
        t.courses = t.courses.map((c) => (c.id === "c1" ? { ...c, is_active: false } : c));
        for (const u of us) t.course_assignments.push(ownRow(u));
        t.course_attempts.push(att(us[1], inProgress));
      } },
    { label: "an inactive course with a completed row: and its grants", calls: 3, courseActive: false,
      patch: (t, us) => {
        t.courses = t.courses.map((c) => (c.id === "c1" ? { ...c, is_active: false } : c));
        t.course_attempts.push(att(us[0]));
      } },
  ];
  for (const w of callWorlds) {
    await guarded(w.label, async () => {
      const measured: string[] = [];
      for (const [n, others] of [[5, 95], [50, 50], [5, 2_495], [50, 2_450]] as const) {
        const users = usersOf(n);
        const { db } = readerDb(users, (t) => w.patch(t, users), undefined, others);
        let counted = 0;
        await readCourseReminderLines(db.client, { orgId: "org1", courseId: "c1", courseActive: w.courseActive ?? true, userIds: users, countCall: () => { counted++; }, now: NOW });
        measured.push(`${n} of ${n + others}: ${counted} counted, ${db.queries.length} made`);
      }
      eq(`${w.label}: ${w.calls} calls, each counted, for 5 and 50 learners in an organisation of 100 and of 2,500`,
        measured, [[5, 95], [50, 50], [5, 2_495], [50, 2_450]].map(([n, o]) => `${n} of ${n + o}: ${w.calls} counted, ${w.calls} made`));
    });
  }
  await guarded("a course with no version", async () => {
    const users = usersOf(5);
    const { db } = readerDb(users, (t) => {
      t.course_versions = t.course_versions.filter((v) => v.course_id !== "c1");
      for (const u of users) t.course_assignments.push(ownRow(u));
    });
    const lines = await readCourseReminderLines(db.client, { orgId: "org1", courseId: "c1", courseActive: true, userIds: users, now: NOW });
    eq("a course with no version: no attempts read, the versions and their own rows only; everybody not started",
      [db.queries.some((q) => q.table === "course_attempts"), db.queries.map((q) => q.table), users.map((u) => lines.get(u)?.status ?? null)],
      [false, ["course_versions", "course_assignments"], users.map(() => "not_started")]);
  });

  console.log("\nADR 0029 (note of 2026-11-25, part 1, point 9) — every read of the reminder's is strict: a failed read throws, never \"not assigned\"");
  {
    // c1 reaches u1 through the static group g1; u2 is reached by nothing,
    // so every step up to the groups is made. The strict cases of stage 2
    // (note of 2026-11-20, part 3), moved from computeLearnerInsights's
    // option onto the reminder's own read.
    const withGroup = (t: Tables) => {
      t.course_assignments.push(courseRow({ assignee_type: "group", group_id: "g1" }));
      t.org_groups.push(group("g1", "static"));
      t.org_group_members.push({ group_id: "g1", user_id: "u1" });
    };
    const withPath = (t: Tables) => {
      withGroup(t);
      t.learning_paths.push({ id: "p1", organization_id: "org1", name: "P1", is_active: true });
      t.learning_path_courses.push({ path_id: "p1", course_id: "c1", step_number: 1, release_at: null });
    };
    const users = usersOf(2);
    const run = async (patch: (t: Tables) => void, override?: (q: Query) => Answer | undefined) => {
      const { db } = readerDb(users, patch, override);
      return readCourseReminderLines(db.client, { orgId: "org1", courseId: "c1", courseActive: true, userIds: users, now: NOW })
        .then((m) => users.map((u) => m.get(u)?.status ?? null), () => "threw" as const);
    };
    const BOOM = { data: null, error: { code: "XX000", message: "stub read failure" } };
    const fails = (table: string) => (q: Query) => (q.table === table ? BOOM : undefined);
    await guarded("the strict cases", async () => {
      eq("the control: every read answered, u1 through the group, u2 by nothing", await run(withGroup), ["not_started", null]);
      eq("the groups cannot be read: throws", await run(withGroup, fails("org_groups")), "threw");
      eq("a static group's rows cannot be read: throws", await run(withGroup, fails("org_group_members")), "threw");
      eq("a database without org_groups (42P01, before 0067): no groups, the read answers", await run(withGroup, (q) => (q.table === "org_groups" ? { data: null, error: { code: "42P01", message: 'relation "public.org_groups" does not exist' } } : undefined)), [null, null]);
      eq("…an error that only names a relation, with no missing-table code, throws", await run(withGroup, (q) => (q.table === "org_groups" ? { data: null, error: { code: "XX000", message: "could not open relation with OID 16384" } } : undefined)), "threw");
      eq("the paths cannot be read, in a world where that step is made (a released step holds the course): throws", await run(withPath, fails("learning_paths")), "threw");
      eq("…its control: the same world with the paths answered", await run(withPath), ["not_started", null]);
      eq("an answer that is not a list (the course's rows): throws", await run(withGroup, (q) => (q.table === "course_assignments" ? { data: null, error: null } : undefined)), "threw");
      eq("an answer that is not a list (the learners' rows): throws", await run(withGroup, (q) => (q.table === "course_attempts" ? { data: null, error: null } : undefined)), "threw");
      eq("a call that throws: throws", await run(withGroup, (q) => { if (q.table === "team_members" || q.table === "learning_path_courses") throw new Error("fetch failed"); return undefined; }), "threw");
    });
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
  // ADR 0014:188's skip ("records could not be read; try again") left with
  // the Report Card's reader (ADR 0029, note of 2026-11-25, part 1, point
  // 9): the reminder's own read throws on a failed grant read, and the
  // request answers 503 and sends nothing (tests/unit/manager-remind-calls.test.ts,
  // step m).
  console.log("\nADR 0029 (note of 2026-11-25, part 1) — the reminder's course branch reads its own lines");
  {
    const src = code("lib/manager/actions.ts");
    const branch = src.slice(src.indexOf('if (target === "course") {'), src.indexOf("const tz = await orgTimezone("));
    const at = (s: string) => branch.indexOf(s);
    eq("the course branch calls readCourseReminderLines, the file never computeLearnerInsights, and no line is skipped as unreadable", [
      at("readCourseReminderLines(a.svc, {") > 0, src.includes("computeLearnerInsights"), branch.includes("records could not be read; try again"), branch.includes("historyUnavailable"),
    ], [true, false, false, false]);
    // ADR 0029: the sends are one run (sendMany), and the state is written with each group.
    eq("…its throw answers 503 before the reminder state's read, the run's sends (sendMany) and the reminder_state upsert", [
      at("readCourseReminderLines(a.svc, {") < at('"The learners\' assignments could not be read. Nothing was sent; try again."'),
      at('"The learners\' assignments could not be read. Nothing was sent; try again."') < at('.from("reminder_state")'),
      at('.from("reminder_state")') < at("sendMany("),
      at("sendMany(") < at('.from("reminder_state").upsert('),
      at('.from("reminder_state").upsert(') > 0,
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

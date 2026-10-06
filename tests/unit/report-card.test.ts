/**
 * Unit test for the Manager Report Card rules (Phase 1; decisions 4 and 5):
 * the Team Learning Score (weights 35/25/25/15, journey weight redistributed),
 * the §3 exception groups (severity-first, max five), the per-person status
 * words, and the §10 struggle diagnosis.
 *
 * Run:  npx tsx tests/unit/report-card.test.ts
 * (No DB. Typechecked by `npm run typecheck`.)
 */
import {
  buildCommonStruggles,
  buildExceptions,
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
import type { ExceptionFlag, LearnerInsight } from "../../lib/manager/types";

let pass = 0, fail = 0;
const eq = (n: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n} — got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); }
};

const flag = (kind: ExceptionFlag["kind"], severity: ExceptionFlag["severity"] = "normal", contentId: string | null = null, title: string | null = null): ExceptionFlag =>
  ({ kind, severity, contentId, contentKind: contentId ? "course" : null, contentTitle: title, detail: `${kind}` });

const learner = (over: Partial<LearnerInsight> & { userId: string }): LearnerInsight => ({
  name: over.userId, email: `${over.userId}@example.test`, avatarUrl: null, designation: null, city: null, branch: null, joined: null,
  assigned: 0, completed: 0, completionPct: null, avgScore: null, assessmentsWithResult: 0, passedFirstTime: 0,
  lastActive: null, inactiveDays: null, activeLast7d: false, journeys: [], courses: [], paths: [],
  flags: [], risk: 0, status: "on_track", completedInPeriod: 0, passedFirstTimeInPeriod: 0, journeyDaysInPeriod: 0, completedInPrevPeriod: 0,
  ...over,
});
const journey = (behind: number, status: "active" | "completed" = "active") => ({
  programId: "j1", name: "30-day", status, unlockMode: "calendar" as const, day: 5, total: 30, behind, overdueDeadline: false,
  daysDone: 4, courseDays: 30, nextModule: "Pricing", onTrack: status !== "active" || behind === 0,
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
      courses: [{ courseId: "c1", title: "Objection Handling", status: "failed", officialScore: 48, attempts: 1, progressPct: 100, assignedAt: null, dueAt: null, overdue: false, startedAt: null, lastActivity: null, passedFirstTime: false, passRequiredUnmet: false, nudges: 0, openGrant: false, limitReached: true }] }),
    learner({ userId: "meera", name: "Meera", risk: 2, status: "watch", flags: [flag("failed", "critical", "c1", "Objection Handling")],
      courses: [{ courseId: "c1", title: "Objection Handling", status: "failed", officialScore: 55, attempts: 1, progressPct: 100, assignedAt: null, dueAt: null, overdue: false, startedAt: null, lastActivity: null, passedFirstTime: false, passRequiredUnmet: false, nudges: 0, openGrant: true, limitReached: true }] }),
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
  const grant = failed.actions.find((a) => a.kind === "grant");
  eq("grant action excludes a learner who already holds an open grant", grant && grant.kind === "grant" ? grant.userIds : null, ["arjun"]);
  eq("not_started dropped by the cap (lowest severity, count 1)", g.some((x) => x.kind === "not_started"), false);
  eq("names can be hidden for non-L1 views", buildExceptions(team, { orgSlug: "acme", namesVisible: false })[1].people[0].name, "A team member");
  eq("stuck group links to the stuck filter", g.find((x) => x.kind === "stuck")?.actions.find((a) => a.kind === "link"), { kind: "link", label: "View learners", href: "/acme/team-performance?status=stuck" });
}
{
  // A learner failed on TWO modules: the tally counts every flag, so the module
  // two people failed wins and both are offered the retry; a learner whose
  // official window is not used up is never offered a grant.
  const l = (courseId: string, title: string, limitReached = true) => ({ courseId, title, status: "failed" as const, officialScore: 40, attempts: 1, progressPct: 100, assignedAt: null, dueAt: null, overdue: false, startedAt: null, lastActivity: null, passedFirstTime: false, passRequiredUnmet: false, nudges: 0, openGrant: false, limitReached });
  const team = [
    learner({ userId: "arjun", name: "Arjun", flags: [flag("failed", "critical", "c1", "Alpha"), flag("failed", "critical", "c2", "Objection Handling")], courses: [l("c1", "Alpha"), l("c2", "Objection Handling")] }),
    learner({ userId: "meera", name: "Meera", flags: [flag("failed", "critical", "c2", "Objection Handling")], courses: [l("c2", "Objection Handling")] }),
    learner({ userId: "sahil", name: "Sahil", flags: [flag("failed", "critical", "c2", "Objection Handling")], courses: [l("c2", "Objection Handling", false)] }),
  ];
  const g = buildExceptions(team, { orgSlug: "acme" })[0];
  const grant = g.actions.find((a) => a.kind === "grant");
  eq("most common module across ALL failed flags", [g.count, g.content?.title], [3, "Objection Handling"]);
  eq("grant targets = everyone who failed THAT module with the window used up", grant && grant.kind === "grant" ? [grant.courseId, grant.userIds.sort()] : null, ["c2", ["arjun", "meera"]]);
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
    ({ courseId, title, status, officialScore: status === "not_started" ? null : 50, attempts: status === "not_started" ? 0 : 1, progressPct: null, assignedAt: null, dueAt: null, overdue: false, startedAt: null, lastActivity: null, passedFirstTime: false, passRequiredUnmet: false, nudges: 0, openGrant: false, limitReached: status === "failed" });
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
  eq("sums + delta", periodSummary(team, 30), { days: 30, coursesCompleted: 4, passedFirstTime: 2, assessmentsWithResult: 2, journeyMissions: 10, completionsDelta: 1 });
  eq("all-time has no delta", periodSummary(team, null).completionsDelta, null);
}


console.log("\nL2 (§6): teams compared, team exceptions, common struggles");
{
  const fl = (courseId: string, title: string) => ({ courseId, title, status: "failed" as const, officialScore: 40, attempts: 1, progressPct: 100, assignedAt: null, dueAt: null, overdue: false, startedAt: null, lastActivity: null, passedFirstTime: false, passRequiredUnmet: false, nudges: 0, openGrant: false, limitReached: true });
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
  eq("team exceptions: Asha first with a why + review suggestion + open/email actions", [ex[0].managerId, /2 failed Objection Handling/.test(ex[0].summary), /1 overdue/.test(ex[0].summary), ex[0].suggestion, ex[0].actions.map((a) => a.label)], ["mgrA", true, true, "Review with Asha this week", ["Open team report", "Email Asha"]]);
  eq("clean own team is not listed", ex.some((e) => e.managerId === "me"), false);
  const cs = buildCommonStruggles(teams, byId);
  eq("Objection Handling fails in 2 of 3 teams → content gap", [cs[0].title, cs[0].teamsAffected, cs[0].teamsFailing, cs[0].teamsTotal, cs[0].failed, cs[0].diagnosis], ["Objection Handling", 2, 2, 3, 3, "content"]);
  eq("no email callback / non-direct manager → no mailto action", buildTeamExceptions(cards, { orgSlug: "acme", managerEmail: () => null })[0].actions.map((a) => a.label), ["Open team report"]);
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

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);

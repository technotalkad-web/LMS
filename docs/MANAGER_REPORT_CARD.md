# Manager Report Card — Phases 1 (L1), 2 (L2) and 3 (L3)

Approved proposal: "Manager Report Card" (decisions 1–11, 2026-10-06).
Phase 0a = official pass/fail everywhere (0090), Phase 0b = explicit reporting
line + Master Data (0091, `docs/REPORTING_LINES.md`). Phase 1 = the L1 screen,
the employee report and three manager actions. Phase 2 = the L2 "team of
teams" screen (teams compared, team-level exceptions, common struggles, team
drill-down, compare). Phase 3 = the L3 organisation view (cities / L2 groups
compared, org-wide learning gaps, people filters, the 15-minute precompute).

## Where it lives

| Piece | Path |
|---|---|
| Level-aware entry (L1 screen for level 1, L2 for level 2, L3 for level 3) | `app/[org]/(learner)/team-performance/page.tsx` |
| L1 screen as a component (own team and any team drilled into) | `_components/l1-view.tsx` |
| L2 screen (§6; also a city / L2 group opened from the L3 screen via `?city=` / `?l2=`) | `_components/l2-view.tsx` |
| L3 screen (§7) | `_components/l3-view.tsx` |
| Team drill-down (a team inside the viewer's hierarchy) | `team-performance/team/[managerId]/page.tsx` |
| Compare 2–3 teams / cities / L2 groups, optionally against "everyone under you" (§8) | `team-performance/compare/page.tsx` (`?teams=a&teams=b` or `a,b`; `?cities=` repeated; `?l2s=`; id `org` = hierarchy average; `?vertical=`/`?branch=` honoured) |
| Precompute for the L3 screen (§13) | `lib/manager/cache.ts` + `POST /api/cron/report-card-refresh` (every 15 min, `cron.yml`) + `0093_report_card_cache.sql` |
| Employee report | `app/[org]/(learner)/team-performance/[userId]/page.tsx` |
| Client pieces (filters, action buttons, assign dialog) | `app/[org]/(learner)/team-performance/_components/` |
| Access / scope | `lib/manager/access.ts` |
| Per-learner insights (data) | `lib/manager/insights.ts` |
| Rules (score, exceptions, struggles, status) | `lib/manager/report-card.ts` — pure, unit-tested |
| Actions | `lib/manager/actions.ts` → `POST /api/manager/{remind,grant,assign}` |
| Migration | `0092_manager_actions.sql` (`attempt_requests.source` gains `'manager'`) |

## Access (decision 3)

- Nav item + page: anyone **named as L1, L2 or L3 by at least one active
  employee** who is themselves an **active** member (`isNamedManager`,
  `loadManagerContext` — a suspended/inactive manager sees nothing, matching
  the action routes). Role is not consulted; a `user`-role manager reaches it through the learner shell
  (desktop top nav and the mobile bottom nav "Team" item).
- Level 1 shows the **direct team** (`scope.direct`). Level 2 shows **teams
  compared** over everyone in the hierarchy (`scope.teamsByL1`; the viewer's
  own direct team is one of the teams; people whose L1 is outside the
  hierarchy are counted but listed separately).
- Level 3 shows the **organisation view** (§7) over everyone in the hierarchy:
  Organisation Learning Score, top teams / teams needing support, **cities
  compared** (or **L2 groups** compared — `?by=l2`; an L2 group is that L2's
  L1 teams plus their own direct reports, `l2GroupsOf`), major learning gaps
  (content-level, `buildOrgGaps`), and people filters (`?city=`, `?vertical=`,
  `?branch=`) on top of period and content. No individual is named on the L3
  screen. Clicking a city / L2 group opens it as a teams-compared screen
  (`?city=X` / `?l2=<id>`, filtered to people in the hierarchy); clicking a
  team opens its L1 screen; the employee report sits under that. Compare
  accepts cities / L2 groups and the hierarchy average (`org`).
- Team drill-down, the employee report and every action re-check the
  hierarchy (`scope.all` / `teamsOf`) on the server; an out-of-scope id is a
  404 / 403, never a partial result. Email shows only for the viewer's own
  direct reports (§12: names, never emails, outside the L1 view).
- The old `gamification_settings.leaderboard_team_leader_view` toggle no
  longer affects this page (decision 10); it still governs the Verticals
  leaderboard.
- Impersonation (platform owner) resolves no hierarchy → "No team mapped yet".
  Admins keep their org-wide reports; there is no admin bypass here.

## The numbers (decisions 4, 5; §2–§3, §10)

All reads are service-role, chunked (`lib/db/chunked.ts`), scoped to the
team's user ids, and live. `computeLearnerInsights` reuses:

- assignment expansion (user / team / group / org, released only; path steps
  entitle their courses and **only released steps count**), the same as
  Analytics and the CRM progress API;
- the official-attempt rule (`computeScoring` + policy + consumed grants):
  status, official score, "passed first time" = official attempt is the
  learner's first completed attempt and passed; "completed in period" is
  dated by the official attempt;
- `computeJourneyState` (journey day / behind / next mission, calendar vs
  progress mode — progress journeys are never "behind");
- `course_attempts.last_activity_at` (not the gamification clock, which
  ignores journey courses) for last active / inactive days;
- `mv_course_performance` for the org fail-rate benchmark (nightly; excludes
  custom-group assignees — labelled on the page).

**Team Learning Score** = weighted average of the four signals that have data
(completion 35, assessment 25, journey 25, engagement 15; a signal with no
data gives its weight to the others). Thresholds live in `THRESHOLDS`.

**Exceptions** (max five, severity first, then count): failed (critical),
overdue (critical), behind on journey (high; ≥3 days or past deadline →
critical), stuck (high: in progress 10+ days with <30%, or idle 7+ days),
not started (normal: assigned 7+ days, never opened), inactive (normal; 14+
days → high), needs manager support (critical: two or more kinds at once, or
the analytics risk score ≥ 5). Per-person status words: **On track · Watch ·
Needs support**.

**Where the team struggles**: exceptions pivoted by course (and journey day),
team fail rate vs org fail rate → *team problem* (team far above org),
*content problem* (org rate high too), *timing* (fresh not-started).

**L2 (§6)**: every team scored with the same four signals (`teamCards`, worst
first), team-level exceptions (`teamSeverity`: critical = bad score or ≥3
failed+overdue or ≥3 needing support; high = amber score or any
failed/overdue/behind; normal = several stuck/not started/inactive) with
"review with <manager> this week" + Open team report / Email <manager>, and
**common struggles** (`buildCommonStruggles`: a module that FAILS in at least
two teams and in ≥ half of them is flagged as a content/training gap; "Failing
in X of Y" counts failing teams, "Flagged in X of Y" any flag). "Email
<manager>" appears only when that L1 manager is the viewer's own direct report
(§12); drill-down and compare links carry the active period/content. Filters:
period, content, `?team=` (→ the drill-down).

Filters (§9) live in the URL: `period` (7/30/90/all — period counts only;
flags are always "now"), `content` (`course:` / `path:` / `journey:`),
`status`.

## Actions (decision 6)

All three: session → org → `loadManagerContext` → every target must be in
`scope.all` — the viewer's hierarchy (else 403 for the whole request; ≤ 50
people per call — each email is several Workers subrequests) → service-role
write.

- **Send reminder now** — course: re-derives entitlement/status for the
  course now (dynamic groups change), skips completed/not-assigned, rate-limits
  to one manual reminder per 20 h via `reminder_state.last_nudge_at`, sends
  `asset_reminder`, records `reminder_state` per learner immediately after a
  send (never batched). Journey: applies the cron's
  "due" gate (calendar: a released mission is pending; progress: today's
  mission is open and nothing was completed today), sends `journey_nudge`
  with the cron's context and **claims `last_daily_reminder_on`** so the hourly cron does not send a second email
  that day (a failed send releases the claim). A paused org returns "email
  reminders are paused for your organisation".
- **Grant retry** — same eligibility as the admin bulk grant (official attempt
  failed, or pass-required and not passed, and the window is used up; a
  granted retake still in progress blocks a second grant), one open grant per
  learner+course — a lapsed unused grant is first closed as `status='expired'`
  (0092) so the learner can be granted again — `source='manager'` (0092; falls
  back to `'bulk'` before the migration), `decided_by` = the manager, learner
  emailed. The admin Attempt Requests queue shows a "Manager grant" badge.
- **Assign a course** — direct `assignee_type='user'` rows, `assigned_by` =
  the manager, optional due date (a date-only value means the end of that day
  in the org's time zone; today or later), re-assign updates the due date,
  learners emailed (`asset_assignment`).

## The L3 precompute (§13)

An L3 hierarchy is hundreds of people, so the L3 screen (and compare with a
city / L2 group / the hierarchy average) reads per-learner insights that the
15-minute refresh stored in `report_card_cache` (0093): one row per learner
per period window (7 / 30 / 90 / all), written by
`POST /api/cron/report-card-refresh` (`x-cron-secret`, `cron.yml` schedule
`3-59/15 * * * *`) for every organisation with an L3 mapping in use. The
refresh calls the same `computeLearnerInsights` as the live path — one rule
set, no SQL re-implementation — and stores its output; the page then runs the
pure rules (`teamScore`, `teamCards`, `buildOrgGaps`) over the cached rows.

Fallback (`loadScopedInsights`): when the table does not exist yet, when more
than a tenth of the people are missing or older than 45 minutes, or when a
content lens is applied (`?content=`), the page computes live exactly as L1/L2
do; the few people missing from an otherwise fresh cache (a team mapped since
the last refresh) are computed live and merged, so nobody vanishes. The footer
says "Numbers as of HH:MM UTC (refreshed every 15 minutes)" or "Computed live".
Rows for people who are no longer active are pruned on each refresh. L1/L2
never read the cache. The refresh has a 50 s budget per run shared across
organisations (stalest people first inside each; `pending` in the response
says how many were left for the next run) and rotates its starting
organisation so a long list is never cut at the same place.

## Deploy order

Apply `0092_manager_actions.sql` on staging before merging and on prod before
tagging (the grant action works without it but labels the grant `bulk` and
cannot re-grant a learner whose earlier grant lapsed unused).

Apply `0093_report_card_cache.sql` on staging before merging and on prod
before tagging. The L3 screen works without it (live fallback); the cron
endpoint 404s on prod until a tag deploys the route and then fills the cache
on its first run.

## Tests

- `npx tsx tests/unit/report-card.test.ts` — score, status, exceptions,
  struggles, period summary, L2 rules, L3 org gaps and L2 groups (no DB).
- Staging harness (`node_modules/.qa/check-report-card.mjs` in the dev
  session): seeds a manager + team with every exception kind, checks the
  page, the employee report, scope refusals and the three actions end to end.

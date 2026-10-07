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
| Actions | `lib/manager/actions.ts` → `POST /api/manager/remind` (the only direct manager action since Phase 4a); support tickets with context: `lib/tickets/*`, `POST /api/tickets` (+ `[id]/messages`, `[id]/act`) |
| Migrations | `0092_manager_actions.sql`, `0093_report_card_cache.sql`, `0094_report_card_cache_rls_policy.sql`, `0095_manager_tickets.sql` |
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

## Actions (decision 6, replaced by decision 12 in Phase 4a)

Managers **view, analyse and support**; admins **assign, retry, configure and
manage** (approved addendum "Manager Rights and Content Scope", 2026-10-07).
The Phase 1 "grant retry" and "assign a course" endpoints are **removed**
(`/api/manager/grant`, `/api/manager/assign` no longer exist); their code now
lives in `lib/attempts/grant.ts` and `lib/assignments/direct.ts` and is called
only by admin paths. Managers never change scores, results, content or admin
settings (they never could).

- **Send reminder now** (decision 13: the one direct manager support action) —
  session → org → `loadManagerContext` → every target must be in `scope.all`
  (else 403 for the whole request; ≤ 50 people). Course: re-derives
  entitlement/status now, skips completed/not-assigned, one manual reminder per
  20 h via `reminder_state.last_nudge_at`, sends `asset_reminder`, records
  `reminder_state` per learner after each send. Journey: the cron's "due"
  gate, `journey_nudge`, claims `last_daily_reminder_on` (a failed send
  releases it). A paused org returns "email reminders are paused for your
  organisation".
- **Raise a support ticket with the context** — every other need goes
  Support → ticket → admin. See the next section.

## Support tickets from the Report Card (Phase 4a, §3 of the addendum)

A "Raise ticket" button sits wherever the Report Card shows a problem:
- an exception card (`actionsFor`: failed → *grant a retry* for the people who
  failed that module with the window used up and no open grant; overdue →
  *extend a due date* for the overdue people on that module; the reminder
  stays as a direct action);
- the employee report (per failed module → *grant a retry*; a generic ticket
  for that person);
- the L1 header (a generic ticket; the manager picks the people);
- an L2 team exception (`buildTeamExceptions`: the team's flagged people, the
  most-failed module attached);
- an L3 org-wide gap (*content problem*, content only, nobody named).

`RaiseTicketButton` (`_components/report-card-client.tsx`, portalled) opens
the form with the context locked (people, content, exception), lets the
manager choose the request type (`TICKET_CATEGORIES`: grant_retry,
assign_content, extend_due, content_issue, other), a priority, a note and —
for extend_due — the new date, then `POST /api/tickets` with `category` +
`context`. The server (`lib/tickets/context.ts`) re-checks every id against
the manager's hierarchy (`loadManagerContext`; any outsider → 403, never a
partial ticket), resolves the content title from the database, generates the
subject ("Grant a retry · Objection Handling · Priya Nair"), stores
`source='manager'`, `requested_by_level`, and emails the org's admins
(`custom_broadcast`, like attempt requests). Non-managers cannot send a
ticket with context (403).

**Admin side** (`/[org]/tickets`): a *Manager requests* tab, each card with
the context (people → Learner 360 links, content → its admin page, the
exception), the thread, and one-click actions that run the same code as the
admin screens — **Grant retry** (`grantExtraAttempts`, `source='ticket'`,
expiry choice), **Assign** / **Extend due date** (`assignCourseDirect`; a
date-only due date = end of that day in the org's time zone; an existing
direct assignment gets the new date; *extend* creates a direct assignment for
someone who held the course only via a team / group / org row and sends no
"assigned" email — on the Report Card a person's **direct assignment date
overrides inherited dates**, so one person can be extended without touching
the team's date), **Decline** (with a reason), **Mark
resolved**. Each closes the ticket with an `outcome`, posts a thread message
and emails the requester (`POST /api/tickets/[id]/act`, admin only). Replies
in both directions go through `POST /api/tickets/[id]/messages`
(`help_ticket_messages`; a requester reply reopens a closed ticket as
in_progress; the other side is emailed). `PATCH /api/tickets/[id]` now checks
the admin role explicitly (403, not a silent RLS no-op). The Attention Center
labels manager tickets "Manager request"; the Attempt Requests queue shows
"Granted from a ticket". Learner tickets from Help & Support are unchanged
apart from the thread and the reply box.

Paths and journeys: the ticket carries them as context; the admin acts from
the path / journey admin page and marks the ticket resolved (one-click
actions cover courses in 4a).

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
  page, the employee report, scope refusals, the reminder action and the
  ticket flow end to end (raise with context, scope refusal, admin inbox,
  grant / assign / extend / decline from the ticket, thread, emails logged).

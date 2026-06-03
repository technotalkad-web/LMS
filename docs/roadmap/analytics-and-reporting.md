# RFC: Analytics & Reporting (Phase 2)

| | |
|---|---|
| **Status** | Draft — awaiting decision |
| **Author** | Arpit Lalani |
| **Created** | 2026-05-31 |
| **Revised** | 2026-05-31 — incorporated product team's concrete metric requirements (§4 rewrite, §5 + §8 updates) |
| **Ticket** | #156 |
| **Related** | #143 (enrolled-courses page), #152 (course-learners), #153 (path-learners), #155 (CSV export) |

## Summary

The LMS today captures rich learner-progress data (SCORM CMI commits,
cmi5 verbs, xAPI statements, course/path attempts) but exposes only
**summary metrics** in the admin Reports page. Tenant admins repeatedly
ask: "Which questions are my learners getting wrong?", "How does Team A
compare to Team B on this module?", "Where do learners drop off in this
path?". None of these are answerable today without writing SQL by hand.

This RFC scopes the **granular reporting layer** that closes the gap.
It explicitly evaluates a strategic decision raised by the team:
**build custom analytics directly on Supabase Postgres** vs **integrate
an open-source Learning Record Store (LRS) like Yet Analytics SQL LRS
as the analytics backend**.

**Recommendation:** Build custom on Supabase for the first six reports
(scope defined below). Defer the LRS integration until concrete needs
emerge that the custom build can't meet — most likely cross-LMS
analytics or external xAPI-content interop. Revisit at the 90-day
post-launch mark with real usage data.

---

## 1. Background — what we have today

### Data capture (in place since launch)

| Layer | Where | What is captured |
|---|---|---|
| SCORM 1.2 runtime | `lib/scorm/types.ts`, `app/[org]/(learner)/courses/.../launch/scorm-runtime.tsx` | Full CMI tree: interactions, objectives, lesson_status, suspend_data, score, time |
| SCORM commit endpoint | `app/api/scorm/[attemptId]/commit/route.ts` | Persists each CMI commit to `course_attempts` + raw CMI to `attempt_snapshots` |
| Interaction extractor | `lib/interactions/extract-cmi.ts` | Pulls `cmi.interactions.N.*` rows into structured records |
| xAPI capture | `app/api/xapi/statements/route.ts`, `lib/xapi/process-statement.ts` | Accepts and stores LRS statements |
| cmi5 manifest | `lib/courses/manifest/cmi5.ts` | Reads `cmi5.xml`, sets up runtime |
| Migrations | `0002_courses.sql` (attempts), `0004_xapi.sql` (statements + activity state) | Storage schema |

**The capture layer is solid.** Every interaction-level event the user
generates lands in Postgres.

### Reporting today

Today's admin `/[org]/reports` page renders summary tiles:
enrollment totals, completion percentages, per-team rollups. Plus the
dedicated learners views (#152 / #153) per-course and per-path.

What it does **NOT** offer:

- Per-question response breakdowns ("80% of learners got Q3 wrong")
- Per-learner journey timeline (verb-by-verb event log)
- Cross-cohort comparison (Team A vs Team B on the same module)
- xAPI verb analytics (most common verbs, time-to-completion distributions)
- SCORM `suspend_data` introspection (where learners typically drop off)
- Custom report builder
- Scheduled-email digest of weekly metrics
- Drilldown from rolled-up numbers to individual events

### Why this matters

Tenant admins use these analytics to **improve instructional design**.
"Quiz 3 has a 22% pass rate" is the question. "Question 4 of Quiz 3 has
a 14% correct rate, suggesting the wording is unclear" is the answer.
Without the answer-layer, the LMS reports tell admins something is
wrong but not what to fix.

This is the gap Phase 2 closes.

---

## 2. Problem statement

Build a reporting layer that:

1. Answers the 6 must-have report questions listed in §4
2. Scales to ~100k attempts and ~1M xAPI statements without
   exhausting the Cloudflare Worker's 10ms CPU budget
3. Refreshes on a cadence appropriate to each report (real-time for
   "who completed today", nightly for cohort comparisons)
4. Exports cleanly to CSV / PDF for board reports
5. Stays maintainable by the existing team (no specialized analytics
   skill required to add a new report)

Out of scope for this phase:
- AI-generated insights (parked for Phase 3)
- White-label embeddable widgets for tenant admins to drop into their
  own intranets
- Real-time streaming dashboards (the LMS isn't high-frequency enough
  to justify the infra)

---

## 3. Strategic decision: custom build vs LRS integration

### The proposal under consideration

> "Integrate Yet Analytics SQL LRS as the analytics backend. Forward
> raw xAPI/cmi5/SCORM data to the LRS, hit its APIs to display
> pre-calculated insights in our LMS UI. Saves weeks of custom
> development."

This is a reasonable framing and worth taking seriously. The honest
evaluation below.

### Option A — Custom build on Supabase Postgres

**What it looks like:**
- SQL views (some materialized) on `course_attempts`, `attempt_snapshots`,
  `xapi_statements`, joined to `course_versions`, `organization_members`,
  `teams`
- Server-side reporting endpoints (`/api/reports/...`) that wrap the views
- React dashboard surfaces in the existing `/[org]/reports` page chrome
- Chart rendering with Recharts (already installed)
- Scheduled materialized-view refresh via the existing Cloudflare cron
  infrastructure
- CSV/PDF export via the pattern already established in #155

**Pros:**

- **Zero new infrastructure.** No JVM service to deploy, monitor, back up,
  upgrade, secure. Stays inside the existing Supabase + Cloudflare Workers
  perimeter.
- **Sub-100ms report responses.** No cross-service network hop. Reports
  feel snappy.
- **SQL is the universal data language.** Any team member who writes
  Supabase queries elsewhere in the app can write a report. No new
  query language to learn (xAPI's statement-query API is its own thing).
- **Direct access to relational LMS data.** Joins to `organization_members`,
  `teams`, `learning_paths`, `course_assignments` are trivial — those
  are sibling tables on the same DB. Cross-joining LMS metadata is
  the entire value of these reports.
- **Operational simplicity.** Backed up by the existing nightly Supabase
  → B2 dump (#119). Monitored by the existing UptimeRobot + Sentry.
- **Cost: $0/month extra.** Reports run on the same Postgres bill we
  already pay.

**Cons:**

- **Reinvents the statement-query wheel** for any report that genuinely
  fits the xAPI verb model better than the relational model.
- **Not xAPI-standards-compliant out of the box.** If a tenant wants to
  export their LRS data to a 3rd-party tool (Power BI via xAPI bridge,
  etc.), we'd need to build the export ourselves.
- **No 3rd-party xAPI content interop** for free. A vendor authoring
  tool that emits xAPI statements wouldn't have a generic LRS endpoint
  to point at — we'd be that endpoint and maintain that contract.

### Option B — Yet Analytics SQL LRS integration

**What it looks like:**
- Self-host SQL LRS (Apache 2.0, Clojure/JVM, runs on Postgres or SQLite)
  on Fly.io / Railway / Render — call it ~$10-20/month
- Forward every xAPI statement from `/api/xapi/statements` to the LRS
- **Build a SCORM→xAPI translator** that runs on `/api/scorm/[attemptId]/commit`
  and emits xAPI statements for each cmi.interactions.* / objective /
  lesson_status change. (cmi5 is already xAPI-native so no translator
  needed there.)
- Bridge auth via Basic Auth (xAPI standard) — provision per-tenant
  credentials
- Build the UI dashboards by querying the LRS's xAPI Statement API
  (or its SQL views, if we use SQL LRS's direct-Postgres access mode)
- The LRS owns analytics data; the LMS continues to own user/course
  metadata

**Pros:**

- **Standards-compliant.** xAPI 1.0.3 spec is universally understood
  in the e-learning vendor ecosystem.
- **Generic xAPI endpoint** that any 3rd-party content can point at.
- **xAPI Profiles + Voiding rules** for semantic structure (if we ever
  need those).
- **Separation of concerns.** Analytics data lives in its own service
  with its own scaling profile, independent of the main DB.
- **Easier later integration with external BI tools** (Power BI,
  Tableau) via xAPI bridges.

**Cons:**

- **New service to operate.** JVM runtime (Clojure) — a different stack
  from everything else in the codebase (Next.js / TS / Deno). New
  monitoring, new deploys, new on-call burden, new backup story.
- **Doubles the storage.** Raw events live in Supabase AND in the LRS.
- **SCORM→xAPI translator is real work.** Not "save weeks" — relocate
  weeks. Every cmi commit needs to be translated into properly-formed
  xAPI statements with correct actor / verb / object / context /
  result. SCORM's data model isn't isomorphic to xAPI; the mapping
  has design choices to make per content type.
- **No drop-in embeddable widgets.** SQL LRS's built-in dashboards are
  full HTML pages on their own domain, not React components. We'd
  query its API and render charts ourselves — same React work as
  Option A.
- **Cross-domain auth headaches.** If we ever want to iframe in the
  built-in dashboards, our user is logged into the LMS, not the LRS.
  Need to build an SSO bridge or a proxy.
- **xAPI Statement query API is less expressive than SQL** for the
  cohort-comparison and group-by-team reports our admins actually
  want. xAPI is statement-oriented; reports are aggregate-oriented.
  You end up fetching statements and aggregating client-side — which
  has its own performance ceiling.
- **Cost: $10-30/month** for hosting + new Postgres instance.

### Option C — Hybrid (Option A now, Option B if/when needed)

Build Option A. If/when one of these triggers, layer in Option B as a
**supplement, not a replacement**:

- Tenant explicitly requests xAPI export to a 3rd-party tool
- 3rd-party content vendor partnership requires a generic LRS endpoint
- We need cross-LMS analytics (impossible if you only have one LMS's
  data)

The Option A data continues to power the in-app dashboards even after
the LRS lands; the LRS becomes a secondary store optimized for export
and 3rd-party interop.

### Recommendation: Option C

For AMBAK's tenant audience (sales managers, ops leads, HR partners),
the reports they care about are **SQL-shaped, not xAPI-statement-shaped**.
They want totals, trends, and team-vs-team rollups, not statement
streams. The Option A SQL-on-Postgres path:

1. Ships ~2–3 weeks of focused work, no new infrastructure
2. Costs $0/month extra
3. Stays maintainable by the existing team
4. Doesn't paint us into a corner — Option B can be added later as
   the LRS becomes a write-side secondary store

The "save weeks" argument for Option B underestimates the SCORM→xAPI
translator work and overestimates the savings (we're building the
React dashboards either way).

### What changes the recommendation

Switch to Option B as primary if:

- A tenant explicitly requires xAPI standards compliance as a contract
  term (compliance-driven, not technical)
- We start integrating 3rd-party content vendors who deliver only xAPI
- The team grows to include someone with operational JVM experience
  who can adopt the LRS without burdening the existing 1–2 person ops
  rotation
- Analytics product surface area grows past ~30 distinct reports, at
  which point xAPI's semantic structure becomes more leverage than
  cost

---

## 4. Report inventory

Concrete v1 requirements from the product team (2026-05-31 update).
Every metric below applies to **both individual courses AND learning
paths** — the path-level view aggregates the same metric across
contained courses.

### 4.1 Enrollment & status (per course / per path)

| Metric | Definition | Data source | Refresh |
|---|---|---|---|
| Total Enrolled | Distinct learners with at least one assignment to the course/path (direct + team + org-wide) | `course_assignments` + `learning_path_assignments` joined with `team_members` + `organization_members` | Real-time |
| Completed | Distinct learners with latest attempt `completion_status = completed` OR `success_status = passed` | `course_attempts` | Real-time |
| In Progress | Distinct learners with at least one attempt but not yet completed | `course_attempts` | Real-time |
| Not Started | Total Enrolled minus (Completed + In Progress) | derived | Real-time |

### 4.2 Performance metrics (per course / per path)

| Metric | Definition | Data source | Refresh |
|---|---|---|---|
| Completion Rate | Completed ÷ Total Enrolled, expressed as % | derived from §4.1 | Real-time |
| Total Passed | Distinct learners with `success_status = passed` | `course_attempts` | Real-time |
| Total Failed | Distinct learners with `success_status = failed` (no later passing attempt) | `course_attempts` | Real-time |
| Average Score | Mean of best score per learner, across all completed attempts | `course_attempts.score` | Nightly (materialized) |
| Average Time Spent | Mean of `completed_at − started_at` per learner, OR `result.duration` from cmi5 xAPI statements when present | `course_attempts` + `xapi_statements` | Nightly (materialized) |
| Overall Rating | Mean of learner-submitted ratings (1–5 stars) for this course/path | **NEW** — needs a `course_ratings` table (see §4.4) | Real-time |

### 4.3 Granular assessment data (per assessment / activity within a course)

| Metric | Definition | Data source | Refresh |
|---|---|---|---|
| Average correct responses | Per question/interaction in the course, % of attempts that answered correctly | xAPI `verb: answered` with `result.success = true`, OR SCORM `cmi.interactions.N.result = correct` | Nightly (mat. view per course) |
| Average incorrect responses | Same shape, `result.success = false` | xAPI / SCORM as above | Nightly |
| Most common wrong answer | Per question, top-N most frequent `result.response` values among incorrect answers | xAPI / SCORM as above | Nightly |
| Drop-off point | Earliest interaction at which a meaningful % of learners stop answering further questions in the same attempt | xAPI / SCORM as above | Nightly |

Granular metrics are most reliable with **cmi5** content (your authoring
tool's export format) — every interaction emits a structured xAPI
statement to `/api/xapi/statements`, which already lands in
`xapi_statements`. SCORM 1.2 content puts the same data in
`cmi.interactions.N.*` rows inside `course_attempts.cmi_data` (JSON);
derivable from either format with a per-format unpacking step.

### 4.4 New data needed — Overall Rating

The "Overall Rating" metric (§4.2) is **not capturable today**. cmi5
doesn't emit a "learner rated this course X stars" verb in the standard
profile, and SCORM has no equivalent. The standard pattern is:

1. After a learner completes a course (or finishes a path), prompt:
   *"Rate this course (1–5 stars). Optional comment."*
2. Store in a new `course_ratings` table:
   ```sql
   create table public.course_ratings (
     id                uuid primary key default gen_random_uuid(),
     user_id           uuid not null references auth.users(id) on delete cascade,
     course_id         uuid not null references public.courses(id) on delete cascade,
     -- For path-context ratings, also tag which path completion
     -- prompted it (so "Marketing Onboarding path" can have its own
     -- composite rating distinct from "Sales Onboarding path"
     -- containing the same course).
     path_id           uuid references public.learning_paths(id) on delete set null,
     rating            smallint not null check (rating between 1 and 5),
     comment           text,
     created_at        timestamptz not null default now(),
     unique (user_id, course_id, path_id)
   );
   ```
3. RLS: learners read+write their own; tenant admins read all in their org.
4. The post-completion prompt UI is a small client component on the
   course-launch result page. Skippable (no force).

This becomes ticket #181 (listed in §8) and is the only schema addition
needed for the v1 metric set.

### 4.5 Implications for the SQL-vs-LRS decision

All seven enrollment/performance metrics in §4.1 + §4.2 are
**SQL-shaped aggregates** — `COUNT(*)`, `AVG(*)`, `WHERE status = X`
group-bys. They are not statement-streams. The granular per-assessment
metrics (§4.3) require **parsing xAPI statements / SCORM interactions**,
but the parsing happens once at materialized-view-refresh time, then
admins query plain SQL views.

This further strengthens the Option A recommendation. The Yet Analytics
SQL LRS's statement-query API is **less expressive** for these aggregate
questions than SQL — you end up fetching statement batches and reducing
client-side, when a single SQL aggregate gives the answer directly.

### Reports deferred to v2 (Phase 2.5)

- Time-to-completion distribution (90th percentile, etc.)
- Per-learner journey timeline (useful for performance reviews)
- Team-vs-team cohort comparison charts (derivable from §4.1+§4.2
  filtered by team, but the chart UX is a separate scope)
- Activity heatmap (when do learners log in)
- Per-question difficulty calibration (item response theory)
- Predictive at-risk learner flagging (Phase 3 — needs the data history
  Phase 2 will accumulate)
- Custom report builder (after v1 reports clarify what tenants actually
  customize)

**Every v1 metric in §4.1 + §4.2 + §4.3 is SQL-shaped or
SQL-after-parsing.** That's the strongest argument for Option A.

## 5. Implementation plan (if accepted)

### Phase 2a — Foundation (week 1)

- Create `supabase/migrations/0031_reports_foundation.sql`:
  - `course_ratings` table per §4.4 (the only new schema beyond views)
  - `mv_course_enrollment_status` — Total Enrolled, Completed, In
    Progress, Not Started per course (§4.1)
  - `mv_course_performance` — Completion Rate, Total Passed, Total
    Failed, Average Score, Average Time Spent (§4.2)
  - `mv_path_enrollment_status` — same shape for paths
  - `mv_path_performance` — same shape for paths
  - `mv_course_interaction_breakdown` — Average correct/incorrect per
    interaction, parsed from xAPI statements (§4.3)
- Add Cloudflare cron `/api/cron/refresh-report-views` to refresh
  the materialized views nightly
- Wire into the existing cron-trigger pattern in `wrangler.toml`

### Phase 2b — Report APIs + UI (weeks 2–3)

- Per-report endpoints under `/api/reports/...`
- Per-report React surfaces:
  - R1 + R2 tabs on `/library/[courseId]`
  - R3 page at `/reports/cohorts`
  - R4 tab on `/users/[userId]`
  - R5 widget on `/learning-paths/[id]`
  - R6 card on `/library/[courseId]`
- CSV export on each (reusing the #155 pattern)
- Recharts charts (already installed; no new deps)

### Phase 2c — Polish (week 4)

- Scheduled-email digest of weekly metrics (Friday morning, tenant-admin
  recipients) — reuses the existing `notifyBackground` pipeline
- PDF export (server-side render via a Cloudflare-compatible PDF library,
  or punt to "Print to PDF" from the browser for v1)
- Per-report help text explaining what the numbers mean

### Estimated total: 3–4 weeks of focused work

Compares to ~5–6 weeks for Option B (which adds the LRS setup +
SCORM→xAPI translator + same React work). And Option A leaves Option
B available as a Phase 2.5 supplement if requirements change.

---

## 6. Decision criteria — when to revisit

This RFC should be re-evaluated if any of these become true:

- **A tenant's contract requires xAPI standards compliance.** Forces
  Option B regardless of internal tradeoffs.
- **We add a 3rd-party content vendor** that delivers only xAPI and
  expects a generic LRS endpoint.
- **A built v1 report can't be answered cleanly in SQL** despite our
  prediction in §4. Means our model of "SQL-shaped reports" is wrong.
- **Custom dashboard maintenance burden grows past ~1 day/quarter** for
  the engineering team. Means the report surface is sprawling and
  Option B's structured statement model would be cheaper to extend.
- **Tenant requests for a custom report builder accelerate.** A
  general-purpose report builder over xAPI Profiles is arguably easier
  than over arbitrary SQL.

Set a calendar reminder for **2026-08-30** (90 days post-launch) to
review actual usage patterns against this RFC's assumptions and
decide whether to revise.

---

## 7. Open questions

- **Should we expose the reports API to tenants programmatically** (i.e.
  publish report endpoints so tenants can build their own dashboards)?
  Probably not v1 — adds support burden. Defer.
- **Where do AI / NLP-generated insights fit?** Probably Phase 3 once
  Phase 2 has accumulated enough history to feed a model. Out of scope
  here.
- **PDF export library on Cloudflare Workers?** Most PDF libs assume
  Node; v1 might rely on browser-side "Print to PDF" rather than
  server-side generation. Investigate during Phase 2c.
- **Multi-tenant aggregate "industry benchmark" reports?** Genuinely
  needs careful privacy thinking — opt-in only, fully anonymized.
  Out of scope for this RFC.

---

## 8. Follow-on tickets (created on RFC acceptance)

If this RFC is accepted as written, break the work into:

- **#175** — Migration 0031: `course_ratings` table + 5 materialized
  views for the §4.1 + §4.2 + §4.3 metric set
- **#176** — Cron: nightly refresh of report views
- **#177** — Reports tab on `/library/[courseId]` surfacing §4.1
  (Enrollment & Status) + §4.2 (Performance)
- **#178** — Reports tab on `/learning-paths/[id]` with the same
  §4.1 + §4.2 metrics, aggregated across contained courses
- **#179** — Granular per-assessment view (§4.3) on the same course
  reports tab — table of every interaction with correct/incorrect %
- **#180** — Most-common-wrong-answer drilldown UI (§4.3) — clickable
  row showing the top-5 wrong responses per question
- **#181** — Post-completion rating prompt + `course_ratings` write
  endpoint (§4.4)
- **#182** — CSV export on every reports surface (reuses the #155
  pattern already shipped for learner views)
- **#183** — Weekly metrics digest email (Friday morning, tenant-admin
  recipients) reusing the existing `notifyBackground` pipeline
- **#184** — PDF export (investigation + implementation)
- **#185** — Time-to-completion distribution (deferred from v1 per §4.5)
- **#186** — Per-learner journey timeline (deferred from v1)

Total ticket count: 12. Estimated 4–5 weeks of one engineer's focused
time. Note: ticket count grew vs the draft (was 9) because §4 specified
more granular metrics than the original sketch.

---

## 9. References

- Yet Analytics SQL LRS: https://github.com/yetanalytics/lrsql
- xAPI 1.0.3 specification: https://github.com/adlnet/xAPI-Spec
- cmi5 specification: https://github.com/AICC/CMI-5_Spec_Current
- ADL Initiative SCORM 1.2 spec: https://adlnet.gov/projects/scorm/
- Earlier conversation thread that produced this RFC: in-product chat,
  2026-05-30.

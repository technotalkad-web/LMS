# RFC: Analytics & Reporting (Phase 2)

| | |
|---|---|
| **Status** | Draft — awaiting decision |
| **Author** | Arpit Lalani |
| **Created** | 2026-05-31 |
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

## 4. Report inventory — the must-have six

Pinning the scope of v1. These are the reports tenant admins will use
on Day 1, drafted from talking to similar B2B-LMS buyers + Ambak's
training-content product knowledge.

For each report: question it answers, intended audience, SQL-shaped
or xAPI-shaped, refresh cadence.

### R1. Course completion funnel

> "What % of learners assigned this course have started / completed /
> passed it?"

- **Audience:** course owner (admin), team lead
- **Shape:** SQL-shaped. Group by `course_assignments` + max
  `course_attempts.completion_status` per learner.
- **Refresh:** real-time (cheap query, every page load)
- **Surface:** new tab on `/library/[courseId]` that drilldown-links
  to #152 learners view

### R2. Quiz / interaction-level breakdown

> "Of all learners who attempted Q3 in this course, what % got it
> right? What were the most common wrong answers?"

- **Audience:** course author (instructional designer)
- **Shape:** SQL-shaped over `attempt_snapshots.cmi_interactions` JSON
  + per-interaction unpacking. Requires a materialized view per course
  for performance at 1k+ attempts.
- **Refresh:** nightly (recompute the materialized view via cron)
- **Surface:** new "Interaction analytics" tab on `/library/[courseId]`

### R3. Team-vs-team cohort comparison

> "How is Marketing's completion rate trending vs Engineering on this
> compliance module?"

- **Audience:** L&D director
- **Shape:** SQL-shaped. Group by `team_members.team_id` × week
  buckets × completion status.
- **Refresh:** nightly
- **Surface:** new `/reports/cohorts` page with team picker

### R4. Per-learner journey timeline

> "What has Jane Doe done across all her assigned content in the last 30
> days?"

- **Audience:** team lead, HR for performance reviews
- **Shape:** Mixed. The high-volume events come from xAPI statements
  (cmi5 / xAPI content); SCORM events come from `course_attempts` +
  `attempt_snapshots`. Union them at query time.
- **Refresh:** real-time
- **Surface:** new "Activity timeline" tab on
  `/users/[userId]` profile page

### R5. Learning path drop-off analysis

> "In this 5-step path, which step do learners most commonly get stuck on?"

- **Audience:** path owner
- **Shape:** SQL-shaped. For each path, count learners who started
  step N but not step N+1.
- **Refresh:** nightly
- **Surface:** new "Drop-off" widget on `/learning-paths/[id]` admin view

### R6. Time-to-completion distribution

> "How long does it typically take a learner to finish this course end-
> to-end? What's the 90th percentile?"

- **Audience:** course author, capacity planning
- **Shape:** SQL-shaped. `min(started_at)` to `max(completed_at)` per
  user per course version, percentile-binned.
- **Refresh:** nightly
- **Surface:** new card on the existing `/library/[courseId]` page

### Reports deferred to v2 (Phase 2.5)

- Verb-frequency analytics across all xAPI content (Option B territory)
- Activity heatmap (when do learners log in)
- Per-question difficulty calibration (item response theory)
- Predictive at-risk learner flagging (Phase 3 — needs the data history
  Phase 2 will accumulate)
- Custom report builder (after v1 reports clarify what tenants actually
  customize)

**All six v1 reports are SQL-shaped.** That's the strongest argument
for Option A.

---

## 5. Implementation plan (if accepted)

### Phase 2a — Foundation (week 1)

- Create `supabase/migrations/0030_reports_views.sql`:
  - `mv_course_completion_funnel` (R1)
  - `mv_team_completion_weekly` (R3)
  - `mv_path_dropoff` (R5)
  - `mv_course_time_distribution` (R6)
- Add Cloudflare cron `/api/cron/refresh-report-views` to refresh
  materialized views nightly
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

- **#175** — Migration: report materialized views (R1, R3, R5, R6)
- **#176** — Cron: nightly refresh of report views
- **#177** — R1 + R2: course-level reports tabs
- **#178** — R3: cohort comparison page
- **#179** — R4: learner journey timeline tab
- **#180** — R5: path drop-off widget
- **#181** — R6: time-to-completion distribution card
- **#182** — Weekly metrics digest email
- **#183** — PDF export (investigation + implementation)

Total ticket count: 9. Estimated 3–4 weeks of one engineer's focused time.

---

## 9. References

- Yet Analytics SQL LRS: https://github.com/yetanalytics/lrsql
- xAPI 1.0.3 specification: https://github.com/adlnet/xAPI-Spec
- cmi5 specification: https://github.com/AICC/CMI-5_Spec_Current
- ADL Initiative SCORM 1.2 spec: https://adlnet.gov/projects/scorm/
- Earlier conversation thread that produced this RFC: in-product chat,
  2026-05-30.

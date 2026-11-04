# Attempt scoring rules

Learners may revisit any module as often as they like — revision is
encouraged. This rule decides **which attempts count** towards scores,
reports, the leaderboard and score bonuses. Since ADR 0014 the rule is the
same for every module; the per-module window is retired (step 9). Legacy
rule rows on a **module**, **learning path** or **journey** (migration 0073)
are kept and read as the platform rule.

## The rule

One official attempt per learner and module: the first completed attempt is
the official result (pass or fail). Every later launch is a **revision
visit**, in the owner's words of 2026-10-21: "Once the official attempt is
completed, the learner can revisit the course as many times as desired. All
slides must be unlocked, and the learner's saved progress must remain
intact. Revision visits must not change the official score, pass/fail
result, completion status, or official activity tracking. Track the number
of revision visits separately. We want this data to understand which courses
learners revisit and find valuable. Do not create a new official result or a
new scored practice attempt for each revision visit." A revision visit is
review only: nothing can be answered, retaken or restarted; Ambak records
the visit in `revision_visits` and nothing else (ADR 0014; the conditions
are under Honest limits below). An additional
official attempt opens only by an admin's grant (below). The scored-attempts
window (`max_scored_attempts`, migration 0073; not the course author's
assessment attempts) is retired by ADR 0014 step 9: every module resolves to
one official attempt, and the Block option no longer exists.

## Where a module's rule comes from

Every module resolves to the platform rule: one official attempt, then
revision visits (ADR 0014 step 9); legacy rule rows are kept and read as
that rule.

The module page shows the rule as a read-only note: "One official attempt,
then review-only revision visits; extra attempts by grant" (ADR 0014 step
9). Existing rule rows, `block` rules included, behave as the default (one
official attempt, then review-only revision visits); the card says so and
keeps "Remove rule". The rule can no longer be changed:
`POST /api/scoring-rules` refuses `after_limit = block` and any value other
than the default. The official attempt is recomputed from the current rule
at every read, so a learner who completed more than one attempt under a
best, latest or nth rule shows their first completed attempt's result from
then on (a pass can become a fail, a score can change).

## What the rule changes

- **Learner course page**: the official score, the official-result history,
  the 'Revision' pill on a completed course, and 'Revisited N times' (ADR
  0014 step 7); the 'Attempt limit reached' button is gone and the
  attempt limit blocks no launch (ADR 0014 step 9); revision visits are
  unlimited.
- **Profile, dashboard, learning-path steps, CRM learner summary** — show the
  official score.
- **Leaderboard (Highest Scorer), monthly recognitions, learner analytics,
  course/path performance reports** — average official scores; a revision
  visit is never scored and never counted as an attempt (ADR 0014).
- **Gyanank / XP** — completion XP and daily-activity XP are unchanged
  (completion stays sticky; a revision visit earns no activity XP, streak
  day or "Most active" credit and moves no last-active value: ADR 0014 step
  12, superseding the 2 October rule). The **perfect-score / high-score
  bonuses fire only on an official attempt**, so a revision visit, which
  never derives a score, earns nothing (ADR 0014 rule A). Each of completion
  XP and the score bonuses is awarded **once per course** (keyed to the
  course, not the attempt). An **admin-granted retake is a new official
  attempt** (0084; ADR 0014), so a retake that first reaches the
  high/perfect tier earns that bonus once — never
  twice for the same course. The learner's **first genuine pass** is likewise
  recorded once per course (the `course_passed` milestone, 0084), so a pass that
  only happens on a granted retake still credits the pass counter and the
  "assessments passed" badge. Completion XP is never paid twice.
- **Completion** is never affected by a revision visit: a completed module
  stays completed and keeps its official score. Revision visits "must not
  change the official score, pass/fail result, completion status, or
  official activity tracking" (the owner's words, above).

## Ordering and edge cases

- Attempts are ordered by completion time. Only an attempt that is completed
  or passed can be official: the official-result chain is the first
  completed non-retake attempt, then each completed granted retake in
  `completed_at` order (ADR 0014 step 7).
- Attempts are counted **per module across all versions and languages**, so
  once the official attempt is complete, switching language or publishing a
  new version does not open another one: every later launch without a
  consumed grant is a revision visit (ADR 0014 rule A). If a new version
  changes the assessment materially, an additional official attempt opens
  only by an admin's grant (below): every module resolves to one official
  attempt (ADR 0014 step 9).

## Requesting another attempt (extra-attempt grants — migration 0083)

A learner who has an official result can ask for another official attempt; a
learner whose result stands (passed, or completed on a module without a pass
mark) is warned before asking, and the admin approves only with a
confirmation and a reason (ADR 0014 step 11):

1. **Request** — on the course page, *Request another attempt* opens a short
   reason box and files a request. Admins are emailed.
2. **Decide** — admins review in **Attempt Requests** (admin nav): learner
   name, module, current official score, and the reason. They **Approve**
   (with an optional note and an expiry — 7/14/30/60/90 days or never; for
   a learner whose result stands, approval requires a confirmation and a
   reason of 3–2000 characters: ADR 0014 step 11) or **Decline** (with an
   optional note). The learner is emailed either way.
3. **Bulk grant** — the same page can grant one extra attempt to *every*
   learner whose official result on a module did not pass (ADR 0014 step 11),
   with no individual request; a learner with a live granted retake is skipped
   (ADR 0014 step 11).
4. **Retake** — the learner's next launch of that module becomes a fresh
   **official** attempt (not a revision): completed progress is reset so they
   start clean. Once completed, the **newest** granted attempt becomes the
   official result, while the first (baseline) score and the full attempt
   history are retained for L&D. The grant is one-time and marked used the
   moment the retake starts.

The grant is consumed by one database transaction (`consume_grant`,
migration 0103) and lapses unused when it was decided before the learner's
current official result, when a granted retake is still in progress, or when
the learner's result stands and the grant carries no confirmation. While the
retake runs the course shows **in progress** (ADR 0014 step 10); the
previous official result stays in the learner's and the admin's history
(step 7). A package update that resets a running retake re-issues the grant
(step 8).

One row models both the request and the grant (`attempt_requests`): at most
one *open* row (pending, or approved-and-unused) per learner per module, so a
bulk grant and an individual request can't double-grant. Grants are counted on
reports (*Extra attempts granted*) and surfaced on the admin learners view.

## Honest limits

- Identical questions on the official attempt and on an additional official
  attempt (which opens only by an admin's grant) can still be memorised.
  Question banks with random draws in the authoring tool remove the cause.
- A revision visit is review only: nothing can be answered, retaken or
  restarted (ADR 0014). **Until re-export, and on KIVO SCORM, KIVO xAPI and
  some third-party courses, revisits still allow unrecorded re-answering**: a
  course published as SCORM or as KIVO xAPI, and any course not yet
  re-exported with the new engine, still lets the learner answer again,
  retake an assessment and Start Over on a revisit, and can show a new score,
  a pass, a badge and a certificate for that run; Ambak records none of it
  and the official result is unaffected (ADR 0014, Consequences).

## API

`GET/POST/DELETE /api/scoring-rules` — admin only (see the route file for
the contract). `POST` refuses `after_limit = block` and any value other than
the default, so the route is read-only except DELETE (ADR 0014 step 9).
`public.effective_attempt_policy(course_id)` /
`effective_attempt_policies(uuid[])` resolve the rule that applies to a
module; `public.v_course_attempt_scoring` and `v_course_attempt_summary`
expose `official_score`, `first_score`, `best_score`, `scored_attempts`,
`practice_attempts` per learner per module, and (since 0090) the official
verdict as `official_status` / `official_attempt_id`. Since 0099
`v_course_attempt_summary` also carries `live_attempt_count`,
`latest_live_completion` and `latest_live_success`, computed over attempts
whose status is not `abandoned` (ADR 0009 step 7), while `attempt_count`,
`latest_completion` and `latest_success` keep counting reset attempts as
history. Extra-attempt grants are
applied both in the application layer (`lib/scoring/attempt-kind.ts` →
`computeScoring(…, retakeIds)`) and in those SQL views (via
`attempt_requests.used_attempt_id`), so the two agree.

Since 0103 `course_attempts.is_revision` marks a revision visit's row,
`revision_visits` counts visits, and `v_course_attempt_scoring` /
`v_course_attempt_summary` exclude `is_revision` rows;
`flag_revision_attempt`, `record_revision_visit` and `consume_grant` are the
service-role functions behind the launch page (ADR 0014 step 2).

Extra-attempt endpoints (all org-scoped, service-role writes after auth):
- `POST /api/attempt-requests` — learner files a request (`orgSlug`,
  `courseId`, `reason`).
- `PATCH /api/attempt-requests/{id}` — admin approve/reject (`action`, `note`,
  `expires_in_days`, `override_passed`). When the learner's result stands,
  approval requires `override_passed: true` and a `note` of 3–2000
  characters (ADR 0014 step 11).
- `POST /api/attempt-requests/bulk` — admin grants to every learner of a
  module whose official result did not pass (`courseId`, `expires_in_days`).
  It skips a learner with a live granted retake, counted in
  `skipped_live_retake` (ADR 0014 step 11).

## Canonical status definitions (Phase 0a, decision 1 — 2026-10-06)

A learner's result on a course comes from their **official attempt only**
(`computeScoring` → `courseStatus` in `lib/scoring/policy.ts`, re-exported with
helpers from `lib/scoring/status.ts`):

| Status | Meaning |
| --- | --- |
| `not_started` | no attempt on any version of the course |
| `in_progress` | attempts exist, none official yet (nothing completed); also while a granted retake runs (ADR 0014 step 10) |
| `completed` | official attempt completed with no pass/fail verdict |
| `passed` | official attempt passed |
| `failed` | official attempt **failed** — a revision visit records no result, so it never turns a fail green or a pass into a failure (ADR 0014 rule A); only a completed granted retake replaces the official result (step 7) |

The SQL views (`v_course_attempt_summary.official_status`), the
learning-path and journey roll-ups and the CRM path objects keep the
standing result while a granted retake runs; the course-level TypeScript
surfaces show `in_progress` (ADR 0014 steps 7 and 10).

The official attempt is the first completed attempt (ADR 0014 rule A) or,
once completed, the **newest admin-granted retake** (0083). **Every surface
must use these helpers** —
learner pages, Admin Analytics, Org Reports, per-course/path learners pages and
CSV exports, the CRM/Yoddha APIs — and the SQL side mirrors it in
`v_course_attempt_summary.official_status` / `official_attempt_id` (migration
0090, grant-aware), which `mv_course_performance.total_failed` now counts.
Never derive a status from "the latest attempt" or count failed attempt rows.
Use `officialStatuses()` for batch (learner × course) resolution and
`countByStatus()` for per-course counts.

# Attempt scoring rules

Learners may revisit any module as often as they like — revision is
encouraged. These rules decide **which attempts count** towards scores,
reports, the leaderboard and score bonuses. Configured by admins per
**module**, **learning path** and **journey** (migration 0073).

## The rule

| Setting | Meaning | Default |
|---|---|---|
| **Maximum scored attempts** | How many *completed* attempts count. Abandoned / interrupted attempts never use a slot. | 1 |
| **Official score** | Which scored attempt is the official number: **first**, **best** of the scored attempts, **latest** scored attempt, or a **specific attempt #N**. | first |
| **Keep first-attempt score** | Retain the first attempt separately for learning-gain analysis (first vs official). The first attempt is always stored; this controls reporting. | on |
| **After the window** | **Practice mode** — learners may keep relaunching; attempts are labelled *Revision / practice* and never change scores or points. **Block** — the Launch button is disabled once the window is used (admins still preview). | practice |

Since the revision rule (migration 0081) the platform default is **one
official attempt**, then unlimited revision: the first completed attempt is
the official result (pass or fail), and every later launch is a *Revision*
run that resumes the learner's saved progress and never changes the official
score or pass/fail. Admins can still widen the window per module/path/journey.

Example: *3 scored attempts + Best* → the highest score from the learner's
first three completed attempts is the official score. Attempt four onwards
is practice.

## Where a module's rule comes from (precedence)

1. The module's own rule (Library → module → *Assessment & attempt rules*).
2. Otherwise, the rule of a **learning path** containing the module. If the
   module sits in several paths with rules, the **most restrictive window**
   (fewest scored attempts) wins.
3. Otherwise, the rule of a **journey** whose curriculum contains the module.
4. Otherwise the platform default: 1 scored attempt, first attempt official,
   practice after.

The module page always shows which rule is in effect and where it came from.
Rules can be changed at any time; scores are recomputed from the stored
attempts on the next report refresh (within 15 minutes) and immediately on
live pages.

## What the scoring window changes

- **Learner course page** — a *Your scoring* panel (official score, best
  scored attempt, scored attempts used, practice attempts) and every attempt
  row labelled *Scored #n* or *Practice*. In practice mode the Launch button
  carries a *Practice mode* pill; when blocked it reads *Attempt limit
  reached* and the launch route refuses the request server-side.
- **Profile, dashboard, learning-path steps, CRM learner summary** — show the
  official score.
- **Leaderboard (Highest Scorer), monthly recognitions, learner analytics,
  course/path performance reports** — average official scores; practice
  attempts are excluded.
- **Gyanank / XP** — completion XP and daily-activity XP are unchanged
  (completion stays sticky; revising still counts as activity). The
  **perfect-score / high-score bonuses fire only on scored attempts**, so a
  memorised perfect score on attempt 7 earns nothing. Each of completion XP and
  the score bonuses is awarded **once per course** (keyed to the course, not the
  attempt). An **admin-granted retake counts as a scored attempt** (0084), so a
  retake that first reaches the high/perfect tier earns that bonus once — never
  twice for the same course. The learner's **first genuine pass** is likewise
  recorded once per course (the `course_passed` milestone, 0084), so a pass that
  only happens on a granted retake still credits the pass counter and the
  "assessments passed" badge. Completion XP is never paid twice.
- **Completion** is never affected: a module completed on attempt 5 is still
  completed; it simply keeps whatever official score the scored attempts
  produced.

## Ordering and edge cases

- Attempts are ordered by completion time. Only attempts that are completed
  or passed enter the window.
- Attempts are counted **per module across all versions and languages**, so
  switching language or publishing a new version does not reopen the window.
  If a new version changes the assessment materially, lower or raise the
  rule as needed — or remove and re-add the module's rule.
- With *specific attempt #N*, the official score appears only once attempt N
  is completed.
- Lowering the window below a learner's existing completed attempts
  reclassifies later attempts as practice immediately (and blocks further
  launches if *Block* is chosen).

## Requesting another attempt (extra-attempt grants — migration 0083)

A learner who has used up their official window and did **not** pass can ask
for another official attempt:

1. **Request** — on the course page, *Request another attempt* opens a short
   reason box and files a request. Admins are emailed.
2. **Decide** — admins review in **Attempt Requests** (admin nav): learner
   name, module, current official score, and the reason. They **Approve**
   (with an optional note and an expiry — 7/14/30/60/90 days or never) or
   **Decline** (with an optional note). The learner is emailed either way.
3. **Bulk grant** — the same page can grant one extra attempt to *every*
   learner who failed a module's official attempt, with no individual request.
4. **Retake** — the learner's next launch of that module becomes a fresh
   **official** attempt (not a revision): completed progress is reset so they
   start clean. The **newest** granted attempt becomes the official result,
   while the first (baseline) score and the full attempt history are retained
   for L&D. The grant is one-time and marked used the moment the retake starts.

One row models both the request and the grant (`attempt_requests`): at most
one *open* row (pending, or approved-and-unused) per learner per module, so a
bulk grant and an individual request can't double-grant. Grants are counted on
reports (*Extra attempts granted*) and surfaced on the admin learners view.

## Honest limits

- Identical questions on every attempt can still be memorised inside the
  window. The rule limits the damage; question banks with random draws in
  the authoring tool remove the cause. Use both.

## API

`GET/POST/DELETE /api/scoring-rules` — admin only (see the route file for
the contract). `public.effective_attempt_policy(course_id)` /
`effective_attempt_policies(uuid[])` resolve the rule that applies to a
module; `public.v_course_attempt_scoring` and `v_course_attempt_summary`
expose `official_score`, `first_score`, `best_score`, `scored_attempts`,
`practice_attempts` per learner per module, and (since 0090) the official
verdict as `official_status` / `official_attempt_id`. Extra-attempt grants are
applied both in the application layer (`lib/scoring/attempt-kind.ts` →
`computeScoring(…, retakeIds)`) and in those SQL views (via
`attempt_requests.used_attempt_id`), so the two agree.

Extra-attempt endpoints (all org-scoped, service-role writes after auth):
- `POST /api/attempt-requests` — learner files a request (`reason`).
- `PATCH /api/attempt-requests/{id}` — admin approve/reject (`action`, `note`,
  `expires_in_days`).
- `POST /api/attempt-requests/bulk` — admin grants to all failed learners of a
  module (`courseId`, `expires_in_days`).

## Canonical status definitions (Phase 0a, decision 1 — 2026-10-06)

A learner's result on a course comes from their **official attempt only**
(`computeScoring` → `courseStatus` in `lib/scoring/policy.ts`, re-exported with
helpers from `lib/scoring/status.ts`):

| Status | Meaning |
| --- | --- |
| `not_started` | no attempt on any version of the course |
| `in_progress` | attempts exist, none official yet (nothing completed) |
| `completed` | official attempt completed with no pass/fail verdict |
| `passed` | official attempt passed |
| `failed` | official attempt **failed** — a later practice pass never turns it green, and a practice fail after an official pass is **not** a failure |

The official attempt is the one the scoring policy designates (first / best /
latest / nth of the scored window) or, once completed, the **newest
admin-granted retake** (0083). **Every surface must use these helpers** —
learner pages, Admin Analytics, Org Reports, per-course/path learners pages and
CSV exports, the CRM/Yoddha APIs — and the SQL side mirrors it in
`v_course_attempt_summary.official_status` / `official_attempt_id` (migration
0090, grant-aware), which `mv_course_performance.total_failed` now counts.
Never derive a status from "the latest attempt" or count failed attempt rows.
Use `officialStatuses()` for batch (learner × course) resolution and
`countByStatus()` for per-course counts.

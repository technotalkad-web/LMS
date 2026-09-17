# Attempt scoring rules

Learners may revisit any module as often as they like — revision is
encouraged. These rules decide **which attempts count** towards scores,
reports, the leaderboard and score bonuses. Configured by admins per
**module**, **learning path** and **journey** (migration 0073).

## The rule

| Setting | Meaning | Default |
|---|---|---|
| **Maximum scored attempts** | How many *completed* attempts count. Abandoned / interrupted attempts never use a slot. | 3 |
| **Official score** | Which scored attempt is the official number: **first**, **best** of the scored attempts, **latest** scored attempt, or a **specific attempt #N**. | first |
| **Keep first-attempt score** | Retain the first attempt separately for learning-gain analysis (first vs official). The first attempt is always stored; this controls reporting. | on |
| **After the window** | **Practice mode** — learners may keep relaunching; attempts are labelled *Practice* and never change scores or points. **Block** — the Launch button is disabled once the window is used (admins still preview). | practice |

Example: *3 scored attempts + Best* → the highest score from the learner's
first three completed attempts is the official score. Attempt four onwards
is practice.

## Where a module's rule comes from (precedence)

1. The module's own rule (Library → module → *Assessment & attempt rules*).
2. Otherwise, the rule of a **learning path** containing the module. If the
   module sits in several paths with rules, the **most restrictive window**
   (fewest scored attempts) wins.
3. Otherwise, the rule of a **journey** whose curriculum contains the module.
4. Otherwise the platform default: 3 scored attempts, first attempt official,
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
  memorised perfect score on attempt 7 earns nothing.
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

## Honest limits

- Identical questions on every attempt can still be memorised inside the
  window. The rule limits the damage; question banks with random draws in
  the authoring tool remove the cause. Use both.
- There is no per-learner override yet ("grant one extra attempt"). Until
  then, temporarily raise the module's window or switch it to practice mode.

## API

`GET/POST/DELETE /api/scoring-rules` — admin only (see the route file for
the contract). `public.effective_attempt_policy(course_id)` /
`effective_attempt_policies(uuid[])` resolve the rule that applies to a
module; `public.v_course_attempt_scoring` and `v_course_attempt_summary`
expose `official_score`, `first_score`, `best_score`, `scored_attempts`,
`practice_attempts` per learner per module.

# Ambak xAPI Analytics Profile (v1.0.0)

The contract for every statement the LMS sends to an external Learning
Record Store (Veracity, Watershed, Learning Locker, SQL LRS …). It is what
turns the LRS from a store of raw engine events into a learning-intelligence
layer: every statement carries a stable content identity, its place in the
hierarchy (question → slide → module → learning path → journey → organisation)
and the learner's dimensions at that moment.

Code: `lib/lrs/profile.ts` (the IRIs), `lib/lrs/enrich.ts` (engine statement
→ enriched copy), `lib/lrs/sweep.ts` (LMS-derived events, SCORM translation,
history backfill), `lib/lrs/context.ts` (dimension lookups). Migration `0078`.

Nothing internal changed: `xapi_statements` still holds the raw engine
statement, `course_attempts` / progress / completion / scoring / journeys are
untouched, and the external copy is built read-only from those tables.

## 1. Decisions (fixed — changing them splits LRS history)

| Decision | Value |
| --- | --- |
| Namespace | `https://ambak.com/xapi/` on every environment (nothing is served there; identifiers only) |
| Learner identity | `mbox` = learner's email (one inverse functional identifier, as the spec requires). Learners without an email fall back to `account { homePage: https://ambak.com/xapi/lms, name: <user id> }`. User id and employee id always ride along as extensions. |
| Retail vs E2E | `learner/segment` = `E2E` when the business vertical is `Fulfillment` (or literally `E2E`), otherwise the vertical as-is. The raw vertical is also sent. |
| History | The first time an org's forwarding is enabled, all history is sent. "Resend all history" in Settings does it again. Statement ids never change, so an LRS that already holds an id keeps its first copy. |
| Per-org format | `tenant_lrs_config.statement_profile`: `ambak-v1` (default, this profile) or `raw` (engine statements verbatim, the pre-0078 behaviour). |

## 2. Activity IRIs (stable, LMS-owned)

| Thing | IRI |
| --- | --- |
| Organisation | `…/activities/org/<org id>` |
| Course / module | `…/activities/course/<course id>` — the same across re-uploads, versions and language packages |
| Slide | `…/activities/course/<course id>/slide/<slide id>` |
| Question | `…/activities/course/<course id>/question/<question id>` (KIVO: `<slide>_q_<id>`; SCORM: `cmi.interactions.n.id`) |
| Other unit | `…/activities/course/<course id>/unit/<unit id>` |
| Learning path | `…/activities/path/<path id>`, step `…/path/<path id>/step/<n>` |
| Journey | `…/activities/journey/<program id>`, day `…/journey/<program id>/day/<n>` |
| Badge / XP | `…/activities/badge/<slug>`, `…/activities/xp/<rule>` |
| Profile (category) | `https://ambak.com/xapi/profile/v1` — on every enriched statement |

The engine's own object id is preserved in
`definition.extensions["…/ext/activity/source-id"]`. Version, language and
engine version are extensions, never part of the id.

## 3. Hierarchy

- `context.contextActivities.parent`: the immediate container — the slide for
  a question, the course for a slide, the path for a step, the journey for a day.
- `context.contextActivities.grouping`: everything the statement rolls up into
  — course, learning path (+ step), journey (+ day), organisation. Grouping
  activities carry `definition.name` so the LRS shows real titles.
- `context.contextActivities.category`: the cmi5 category (kept) + the
  profile activity.
- `context.registration`: the LMS attempt id (unchanged).

## 4. Verbs

| Verb | Sent by | Meaning |
| --- | --- | --- |
| `adlnet…/launched` | LMS (derived) | an attempt started (SCORM, cmi5 and xAPI alike) |
| `adlnet…/initialized`, `experienced`, `progressed`, `answered`, `completed`, `passed`, `failed`, `terminated` | engine (enriched) / SCORM translation | as today |
| `w3id…/adl/verbs/abandoned` | LMS | attempt abandoned (force-restart, dedupe) |
| `adlnet…/completed` on a path step / journey day | LMS | step / day done |
| `w3id…/adl/verbs/satisfied` on a path / journey | LMS | learning path or journey fully completed |
| `adlnet…/registered` | LMS | user-level course assignment |
| `id.tincanapi.com/verb/earned` | LMS | XP awarded (`result.score.raw` = XP) or badge earned |
| `id.tincanapi.com/verb/rated` | LMS | course rating (`result.score.raw` 1–5) |

## 5. Extensions (`https://ambak.com/xapi/ext/…`)

Context extensions on every statement, when known:

- `profile-version`, `statement/origin` (`engine` | `lms` | `scorm`), `statement/environment`
- `learner/user-id`, `learner/employee-id`, `learner/role`, `learner/vertical`, `learner/segment`,
  `learner/branch`, `learner/city`, `learner/state`, `learner/node`, `learner/designation`,
  `learner/job-role`, `learner/grade`, `learner/line-manager-id`, `learner/date-of-joining`,
  `learner/tenure-days` (at the statement's timestamp), `learner/teams` [], `learner/groups` []
- `content/course-id`, `content/course-title`, `content/version-id`, `content/version-number`,
  `content/package-id`, `content/language`, `content/manifest-type`, `content/engine-version`
- `attempt/id`, `attempt/number` (1 = first attempt on the course), `attempt/scored`
  (counts under the course's scoring rule), `attempt/scoring-basis`, `attempt/scoring-max-attempts`,
  `attempt/started-at`
- `path/id`, `path/name`, `path/step`, `path/steps-total`
- `journey/program-id`, `journey/name`, `journey/enrollment-id`, `journey/day`, `journey/days-total`
- `org/id`, `org/slug`
- event-specific: `assignment/id`, `assignment/assignee-type`, `assignment/due-at`,
  `xp/rule`, `xp/amount`, `badge/id`, `rating/stars`

Activity definition extensions on sub-activities: `content/unit-kind`
(`slide` | `question` | `unit`), `content/unit-id`, `content/slide-id`,
`activity/source-id`.

Learner dimensions are stamped **at forward time** (live statements) or at
backfill time (history), i.e. the learner's current member record. Changes of
branch, designation or vertical apply from then on.

## 6. What the LRS can answer

| Question | How |
| --- | --- |
| Which questions fail most | `answered` where `result.success = false`, grouped by object id (+ `content/course-title`, `definition.description`) |
| Which modules have the highest drop-off | `launched` vs `completed` per course; last `experienced` slide before `terminated` |
| Topics with low accuracy but high completion | completion rate vs `answered` success rate per course / slide |
| Exercise types learners struggle with | `answered` success rate by `definition.interactionType` |
| Retail vs E2E | any measure split by `learner/segment` |
| Struggle across modules, paths, journeys | grouping activities (`…/path/…`, `…/journey/…`) |
| Slower learners / groups | `launched → completed` elapsed time, `attempt/number`, split by `learner/groups`, `learner/teams`, `learner/line-manager-id` |

## 7. Still needed from the KIVO engine (small, coordinated)

The LMS now compensates for these, but the engine should send them so the
data is right at the source and available to any LRS without the LMS:

1. Use the `activityId` passed on the launch URL as the root of every object
   id (cmi5 requires it). Today the engine uses a slug of the module title,
   which changes on re-export.
2. Always send `definition.interactionType` and a non-empty `result.response`
   on `answered`; add `result.duration` (time on the question).
3. Add `result.duration` (dwell time) to `experienced`, plus
   `…/ext/content/slide-index` and `…/ext/content/slide-total`.
4. Send `context.contextActivities.parent` (slide for a question, course for a slide).
5. Fix the extension IRI `https://e-learning-engine/extensions/raw-response`
   (not a valid IRI namespace) — use `https://ambak.com/xapi/ext/engine/raw-response`.
6. Authoring: topic / skill tags and difficulty on questions and slides, sent as
   `…/ext/content/topics` [] and `…/ext/content/difficulty`.

## 8. Operations

- Sweeper: runs inside `POST /api/cron/lrs-forward` (every 5 min, GitHub cron)
  before the drainer. Per enabled org: the `statements` source every run plus
  three rotating sources, 200 rows each, cursors in
  `tenant_lrs_config.backfill_cursor`, counts in `backfill_stats`.
- Backfill: Settings → External LRS Integration → "Resend all history"
  (`POST /api/org/lrs/backfill`) stamps `backfill_requested_at`; the next run
  resets the cursors. `backfill_completed_at` is set once every source has
  caught up. Statements keep their ids (idempotent).
- Not derived (documented gaps): org / team / group assignments are not
  expanded per learner (`registered` covers user-level assignments only);
  missed deadlines are not emitted yet.
- Tests: `tests/bot/lifecycle/45-lrs-analytics.spec.ts` (local dev server +
  mock LRS), lint helper `tests/bot/lib/xapi-lint.ts`.

## 9. Deployment

1. Merge; deploy staging (the code is safe before the migration: profile
   defaults to `ambak-v1`, the sweeper and backfill stay inert until the
   0078 columns exist).
2. Apply `supabase/migrations/0078_lrs_analytics_profile.sql` on staging, then
   production, by hand.
3. Configure the LRS in Settings (endpoint, key, secret), Test connection,
   Enable. History is sent automatically; watch the History line on the card.

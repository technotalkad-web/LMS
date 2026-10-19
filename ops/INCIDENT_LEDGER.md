# Incident ledger

Wrong-content, record-protection and learner-impact incidents, and every corrective action taken on them (ADR 0004 decision 3, step 12).

Rules for this file:

- Ids, dates and reasons only. Never a person's name or email; attempts are identified by attempt id and, where it matters, by role class (learner or staff).
- Ids are the first 8 hex characters of the row's uuid, as in the ADRs, unless written in full.
- Entries are appended, never rewritten. A correction is a new line that names the entry it corrects.
- Environment is stated on every entry (staging or production).

## 1. Versions serving the wrong bytes

| Recorded | Env | Version | Course / slot | What is wrong | Status |
|---|---|---|---|---|---|
| 2026-10-15 | staging | 7ff60dde | "Turning Escalations Into Excellence" (a5b3396a), Hindi slot | Stored bytes are the Framework module since 2026-06-04; the row's `manifest_data` title is correct. Original lost by overwrite; best-evidence original = TEST LMS.zip (owner-held export outside the repository). | Open: corrected version via D5a; in-progress attempts stay until D5b |
| 2026-10-15 | staging | d4f05fac | Same course, current Gujarati slot (display name "This is for test") | Stored bytes are the Framework module. Was the course default version (`courses.current_version_id`) at 2026-10-16. | Open: D5b deactivates the slot |
| 2026-10-16 | staging | 3b005ed1 | "The A.M.B.A.K. Framework" (7e1f624d), default-language slot | Stored bytes are Turning Escalations Level 1 SCORM; 0 attempts. Was that course's default version at 2026-10-16. | Open: D5a deactivates the package |
| 2026-10-16 | staging | 887d4aaf | Same course, Hindi slot | Stored bytes are Turning Escalations Level 1 SCORM; 0 attempts. | Open: D5a deactivates the package |
| 2026-10-15 | staging | 9dcdad9b | "The A.M.B.A.K. Framework", Marathi v1 (SCORM) | Original lost; one completed staff attempt. | Left as is; never re-activated (ADR 0004 step 15) |
| 2026-10-18 | staging | 7ff60dde | Corrects the 2026-10-15 entry | D5a done 2026-10-17: TEST LMS.zip uploaded as 5f836158 (v2) in the same Hindi package (grandfather); 5f836158 is the package's current version and the course default. | Partly closed: new learners get 5f836158; the 6 in-progress attempts stay on 7ff60dde until D5b |
| 2026-10-18 | staging | 3b005ed1 | Corrects the 2026-10-16 entry | Package 104a6740 hidden from learners (D5a, 2026-10-17); 0 attempts. The package now carries language `pa` (Punjabi), set through the Library "Promote to" control between 2026-10-17 and 2026-10-18 (promotion is not audited); it stays hidden. | Closed |
| 2026-10-18 | staging | 887d4aaf | Corrects the 2026-10-16 entry | Package 42d6ae90 hidden from learners (D5a, 2026-10-17); 0 attempts. | Closed |
| 2026-10-19 | staging | 7ff60dde | Corrects the 2026-10-18 entry | D5b done 2026-10-18 (§5): its five in-progress learner and staff attempts reset; 5f836158 serves the corrected module. One staff grant retake (42ee946f) remains in progress on 7ff60dde by design. | Closed on staging (one staff grant retake left by design) |
| 2026-10-19 | staging | d4f05fac | Corrects the 2026-10-15 entry | D5b done 2026-10-18 (§5): Gujarati package 1337fa47 hidden; its one in-progress learner attempt reset. | Closed on staging |

## 2. Versions repointed to their own folder (step 0)

| Date | Env | Version | Action | Reason |
|---|---|---|---|---|
| 2026-10-14 | staging | 887d4aaf | `storage_prefix` repointed to its package-scoped folder `courses/{courseId}/{packageId}/v{n}/` | Shared another course's folder (step-0 incident); bytes unchanged by the repoint |
| 2026-10-14 | staging | 3b005ed1 | Same | Same |
| 2026-10-14 | staging | d4f05fac | Same | Same |

## 3. Wrong course defaults

| Recorded | Env | Course | Default version | Why wrong | Cause |
|---|---|---|---|---|---|
| 2026-10-16 | staging | a5b3396a | d4f05fac (Gujarati slot) | Learners without a language preference get the Framework module | `publishVersion()` repoints `courses.current_version_id` on every upload and every "Make current" on any slot |
| 2026-10-16 | staging | 7e1f624d | 3b005ed1 (default-language slot) | Learners without a language preference get Turning Escalations Level 1 | Same |
| 2026-10-18 | staging | a5b3396a | 5f836158 (Hindi v2, the D5a corrected version) | Closed, corrects the 2026-10-16 entry: the D5a upload of 2026-10-17 moved the default under the old `publishVersion()`; verified read-only 2026-10-18 | Default rule fixed by ADR 0008 B (merged #183): uploads move the default only inside its own slot |
| 2026-10-18 | staging | 7e1f624d | 2e404b48 (Marathi) | Closed, corrects the 2026-10-16 entry: owner clicked "Set as default" on the Marathi slot at 2026-10-18 05:04:16 UTC (audit `course.default_slot_set`, previous 3b005ed1); verified read-only; attempts on the course unchanged | Same |

## 4. Attempts on the wrong slots (read 2026-10-16, ADR 0004 step 12a)

Staff attempts that stay untouched (failed and abandoned; reason "wrong bytes served"):

| Version | Attempt | Role class | Status |
|---|---|---|---|
| 7ff60dde | e3a6c2dc | staff | failed |
| 7ff60dde | d9eea7b8 | staff | failed |
| 7ff60dde | f91ce8a6 | staff | abandoned |
| 7ff60dde | 4bf43888 | staff | abandoned |
| d4f05fac | 0e496389 | staff | failed |
| d4f05fac | 571a59f7 | staff | abandoned |
| d4f05fac | 455e1840 | staff | abandoned |
| d4f05fac | e8266752 | staff | abandoned |

In-progress attempts (the D5b list; re-read on the day of the owner's go, it may have changed):

| Version | Attempt | Role class | Note |
|---|---|---|---|
| 7ff60dde | 6cec0b33 | learner | |
| 7ff60dde | 1a6d679a | learner | same learner as 0a005088 |
| 7ff60dde | 6efb5efc | learner | |
| 7ff60dde | b238c46c | staff | |
| 7ff60dde | 42ee946f | staff | |
| 7ff60dde | 6da4af36 | staff | |
| d4f05fac | 0a005088 | learner | same learner as 1a6d679a |

Affected learners for D5b: three (attempts 6cec0b33, 1a6d679a / 0a005088, 6efb5efc). No journey, learning path, completion, score or XP on any of the seven in-progress attempts at 2026-10-16.

## 5. Corrective actions

D5a (now, zero restarts; owner-run through the admin UI; ADR 0004 step 13). One line per action, with its date, when it is done:

| Date | Env | Action | Target | Result |
|---|---|---|---|---|
| 2026-10-17 | staging | Replace-package, `mode = grandfather`, TEST LMS.zip as a new version, update email unticked | Hindi package of a5b3396a (current version 7ff60dde) | 5f836158 (v2) current and course default; 6 in-progress attempts stay on 7ff60dde; 0 abandoned. TEST LMS.zip shows the same resume failure as the version it replaces (engine issue, KIVO release A); not for production |
| 2026-10-17 | staging | Deactivate package (PATCH `is_active: false`) | Package holding 3b005ed1 | 104a6740 hidden; 0 attempts; verified 2026-10-18 |
| 2026-10-17 | staging | Deactivate package (PATCH `is_active: false`) | Package holding 887d4aaf | 42d6ae90 hidden; 0 attempts; verified 2026-10-18 |
| 2026-10-18 | staging | Set as default (ADR 0008 step 16; replaces "Make current", which could not move a default between slots) | 2e404b48 (Framework, Marathi) | Course default 2e404b48 at 05:04:16 UTC, audit row written; verified read-only |

D5b (later, only on the owner's explicit go against the re-read list of section 4; ADR 0004 step 14). Each closed attempt id goes here with the date and the go:

| Date | Env | Owner go | Action | Attempt / target |
|---|---|---|---|---|
| 2026-10-18 | staging | owner's standing direction of 2026-10-18 (staging is test data; ADR 0004 decision 2 note) | Per-version restart of 7ff60dde through the Library "Restart learners on this version" (owner's own admin session; dry-run preview 5 attempts, 1 grant retake excluded); audit `course.version.attempts_restarted` d32079f6 at 16:37:01 UTC, reason "D5b: Correct affected staging attempts from the wrong Hindi course version." | 7ff60dde: 1a6d679a learner, 6cec0b33 learner, 6efb5efc learner, 6da4af36 staff, b238c46c staff → abandoned. 42ee946f staff stays in progress by design (approved grant retake a6db5c02, excluded by ADR 0008 step 3) |
| 2026-10-18 | staging | owner's standing direction of 2026-10-18 (staging is test data; ADR 0004 decision 2 note) | Deactivate the Gujarati package (Library, "Hidden from learners"); not the course default (5f836158) | Package 1337fa47 (current version d4f05fac) → inactive |
| 2026-10-18 | staging | owner's standing direction of 2026-10-18 (staging is test data; ADR 0004 decision 2 note) | Per-version restart of d4f05fac (current version of the now-inactive package; ADR 0008 step 2) through the Library; audit d32079f6's sibling dee4783a at 17:30:41 UTC, reason "D5b: Correct the staging learner's attempt on the wrong Gujarati course version." | d4f05fac: 0a005088 learner → abandoned |

Completions earned on a wrong slot during the grandfather window are recorded here, never rewritten:

| Date | Env | Version | Attempt | Note |
|---|---|---|---|---|

## 6. Production

The P1 read-only audit (ADR 0007 step 2, ADR 0004 step 16) lists the production slots whose stored bytes disagree with their row, the wrong defaults and the inactive packages with in-progress attempts; each finding is entered here before any action.

| Recorded | Env | Finding | Impact | Action / status |
|---|---|---|---|---|
| 2026-10-19 | production | Migration state differs from the release documents. The owner's read-only audit (16:06 UTC, `ops/release-v1.3.0-audit.sql`; CSV kept private) found 0072 and a 0073 applied (`B0072`, `B0073`, `B0073b` present; `Z01` `0074`; `Z02` `none`); the documents assumed 0071 (ADR 0007 Context, `docs/release/v1.3.0.md` §1). Source not recorded: a hand-apply at an unrecorded date after 2026-09-23 (`scripts/check-migration-grants.mjs`, written that day in 8a50667, still names 0073 as the first migration pending on production), of either the 1375511 copy of 0073 (#114, no explicit grants; `main`'s file until 2026-10-14) or the current copy (explicit Data API grants; on `fix/migration-grants` from 2026-09-23, on `main` since #170, 5240d80). The audit cannot tell the two copies apart. Asked the same day, the owner did not know whether they or someone on their behalf applied 0072/0073 and chose not to guess; recorded as unknown. No ids: the audit listed no rows. | None on data: production has no courses or attempts (every D row 0). | Sitting order adjusted (`docs/release/v1.3.0.md` §4.3): 0032, then 0072 and the current 0073 pasted again, then 0074–0098 (variant a; variant b, without the re-paste, is the fallback), both rehearsed from this state. Who applied 0072/0073, when and from which file stays unknown (optional evidence: the production dashboard's Database → Migrations list shows whether the Supabase CLI recorded them). It has no bearing on variant (a), which pastes the current 0073 either way. |

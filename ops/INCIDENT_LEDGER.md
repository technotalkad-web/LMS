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
| | staging | Replace-package, `mode = grandfather`, TEST LMS.zip as a new version, update email unticked | Hindi package of a5b3396a (current version 7ff60dde) | |
| | staging | Deactivate package (PATCH `is_active: false`) | Package holding 3b005ed1 | |
| | staging | Deactivate package (PATCH `is_active: false`) | Package holding 887d4aaf | |
| | staging | Make current | 2e404b48 (Framework, Marathi) | |

D5b (later, only on the owner's explicit go against the re-read list of section 4; ADR 0004 step 14). Each closed attempt id goes here with the date and the go:

| Date | Env | Owner go | Action | Attempt / target |
|---|---|---|---|---|

Completions earned on a wrong slot during the grandfather window are recorded here, never rewritten:

| Date | Env | Version | Attempt | Note |
|---|---|---|---|---|

## 6. Production

Nothing recorded yet. The P1 read-only audit (ADR 0007 step 2, ADR 0004 step 16) lists the production slots whose stored bytes disagree with their row, the wrong defaults and the inactive packages with in-progress attempts; each finding is entered here before any action.

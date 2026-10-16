# 0002. Future-first strategy: legacy frozen and protected, future packages certified

Status: Accepted (owner, 2026-10-16)
Acceptance: accepted by the owner on 2026-10-16 after two checks (the migration numbering against the database history, ADR 0003 step 7a; the per-attempt learner impact of the Hindi and Gujarati corrections, ADR 0004 §5), on two conditions that bind ADR 0002–0007: (a) no learner attempt is restarted or abandoned until the owner gives an explicit go after seeing the per-attempt impact list; (b) production migration state is confirmed in the P1 read-only audit (ADR 0007 step 2) before any production apply. All steps of this record are accepted as written; the owner's answers to the decisions requested below are recorded in that section. One Context fact is corrected by the 2026-10-16 impact check: the two other versions repointed in step 0 (887d4aaf and 3b005ed1, the Hindi and default slots of "The A.M.B.A.K. Framework") are not correct; they hold Turning Escalations Level 1 SCORM with no attempts. ADR 0004 records the finding and its D5a handles it.
Date: 2026-10-15
Deciders: owner; architect (Fable 5.1)

## Context

The owner's direction on 2026-10-15, condensed: adopt a future-first strategy; do not spend excessive time repairing every legacy package; apply only the essential fixes needed to protect existing learners, prevent incorrect content delivery and preserve historical records; then prioritise KIVO's engine fixes, the Ambak Learning Data Standard (ALDS), the Package Guardian and automated LMS validation; all future packages must pass these checks before they are approved for reliable analytics.

Facts behind it (staging, read-only, at a89832f):

- 42 course versions: 26 SCORM 1.2, 16 cmi5; 355 attempts, 315 of them on SCORM versions. The v1 question analytics (migrations 0031/0035) read `xapi_statements` only, so SCORM courses have never had question-level data.
- Every `answered` statement from the current KIVO engine carries the cmi5 category and `en-US` labels regardless of content language; at least ten interaction kinds produce defective answer records; the engine never mints statement ids, so retries create duplicates. Legacy packages cannot be certified without re-export, and re-exporting every legacy package is the repair effort the owner directed us to avoid.
- Two staging versions serve bytes that differ from their row (7ff60dde serves another course's module; 9dcdad9b's original is lost), and one current slot holds another course's module (d4f05fac, the Gujarati slot of Turning Escalations; the three versions repointed in step 0 got their own folders, not new bytes, and the other two are correct). Production packages have no scheduled backup. The statements route overwrites stored statements on a resent id.
- The learning-data blueprint (`docs/ambak-learning-data-standard/BLUEPRINT.md`, v2) was written for a full programme: registrations, a strict gateway with quarantine, SCORM journaling, legacy alias import, a per-org strict flip after every KIVO package is re-exported. Three review passes (certification, dependencies, product/model/delivery) found that order and scope unworkable for a first certified package and proposed the trimmed plan this ADR adopts.

## Decision

1. **Legacy is frozen and protected.** Every version uploaded before the Package Guardian exists in its environment, and every SCORM package at any time, is "legacy": it is not repaired, not re-exported for analytics reasons, never deleted, and its question data is labelled unverified. Protection is ADR 0003 (records) and ADR 0004 (delivery).
2. **Future packages are certified.** Only KIVO 2.0 cmi5 packages that pass the certification model of ADR 0005 feed reliable question analytics. Uncertified packages still launch and still count for completion, scoring, Report Card, CRM and journeys.
3. **Phase order** (details in `docs/ARCHITECTURE.md` §6): P0 protect and preserve → P1 production release v1.3.0 → P2 KIVO engine release A (parallel) and P3 ALDS rules as code (parallel) → P4 KIVO 2.0 export plus LMS launch contract plus Guardian, shipped per environment together → P5 certified question analytics → P6 only on its trigger.
4. **Not doing** (binding scope cuts): legacy repair or re-export; Level 1 question identity, aliases, families, legacy-object-id, LMS alias import (the KIVO in-editor qid upgrade is kept); the §8.1 legacy pre-pass (the R10 grammar parser is kept); SCORM journaling and SCORM question certification; historical backfill into facts; Storyline; multi-AU; SCORM 2004; `served_version_id`; registrations, strict gateway, quarantine, resolution API and AI explainer before the first certified package; an LMS-hosted browser runner; CATAPULT or JSON Schema as the source of truth; the `alds_strict_level2` flip and migration 0102; new `cron.yml` schedules; attempt surgery of any kind.
5. **Blueprint profile.** The blueprint stays authoritative for learning data under the section map in `docs/ARCHITECTURE.md` §5. When the executor writes the trimmed 0099–0101 migrations (numbering per ADR 0003), the DDL is edited consistently with the cuts: grant loops, literal grants and sequence grants drop the cut tables; `question_answers.registration_id` becomes a plain nullable uuid until registrations land; the ingest index and sweeper are restricted to Level 2 or certified versions.
6. **What remains for legacy in later phases:** the v1 matview label expression and incorrect-count exclusions (ADR 0005, P5); the D5 slot clean-up (ADR 0004); the `display_name` relabel of Hinglish slots is an L&D action, not code.

## Consequences

- Learners on legacy packages are protected (no wrong bytes, no silent resets, no lost history) without any package being touched.
- Legacy question analytics stay "unverified" permanently; the first KIVO 2.0 re-export of a course restarts its question history (ADR 0005 labels this in the UI).
- SCORM is never certified; KIVO's SCORM export stays available, and SCORM uploads keep launching and counting for completion.
- The blueprint's registrations, gateway and quarantine are deferred; the LMS keeps `registration = attempt id`, which is cmi5-conformant.
- Effort is bounded: 23–35 executor-days over 6–8 calendar weeks, with owner events (migration applies, tags, editor redeploys, Cloud Run deploys) on the critical path.

## Alternatives considered

- Repair every legacy package: requires re-export of each KIVO course, re-upload into the right slots and a re-run of every learner; the owner declined the content effort, and it would still not certify the old engine's statements.
- Certify SCORM as well: roughly doubles the LMS work (journaling, session token, SCORM ingest branch) for weaker evidence (no per-try timestamps, no drawn set, 255-character responses), and KIVO already exports cmi5 for this LMS.
- Implement the blueprint as written: its gateway needs the catalogue it is ordered before, its 0098 carries registrations the first certified package does not need, and its headless certification has no hosting.
- Do nothing for legacy: leaves wrong-module slots serving learners, no package backup, and a statements route that rewrites history.

## Decisions requested from the owner

1. Confirm the not-doing list in Decision 4 as binding scope. Recommended: yes. Decided (owner, 2026-10-16): yes. The abandon actions of ADR 0004 D5b run through app flows and are not the "attempt surgery" this list excludes.
2. Confirm that the only Hinglish measure in P0 is the `display_name` relabel by L&D (no `hi-Latn` slot code). Recommended: yes; a `hi-Latn` code is added only if a script rule ever becomes gating, which ADR 0004 does not propose. Decided (owner, 2026-10-16): yes.

## References

- `docs/ambak-learning-data-standard/BLUEPRINT.md` §0, §1.5, §2, §3, §5, §6, §8, §9, §10
- `docs/ambak-learning-data-standard/KIVO-P2-P3.md`
- `docs/ARCHITECTURE.md` §5 (section map), §6 (roadmap)
- ADR 0003, 0004, 0005, 0006, 0007

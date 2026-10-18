# 0007. Production release v1.3.0 and operations: pre-tag checklist, scheduler, CI jobs

Status: Accepted (owner, 2026-10-16)
Acceptance: accepted by the owner on 2026-10-16 after two checks (the migration numbering, ADR 0003 step 7a; the per-attempt learner impact, ADR 0004 §5), on two conditions that bind ADR 0002–0007: (a) no learner attempt is restarted or abandoned until the owner gives an explicit go after seeing the per-attempt impact list; (b) production migration state is confirmed in the P1 read-only audit (step 2) before any production apply. All steps are accepted as written except step 2, where the acceptance added the checks listed under "Added at acceptance", and step 9, which now carries condition (a) for the production clean-up. The owner's answers to the decisions requested below are recorded in that section.
Date: 2026-10-15
Deciders: owner; architect (Fable 5.1)

## Context

- Production runs code from 2026-09-17 with the database believed at migration 0071 (`scripts/check-migration-grants.mjs` records 0073 as the first migration still pending on production, so 0072 may already be applied; the P1 audit settles it). Staging is at 0097 plus step 0. No `v1.2.0` tag exists on `origin` (`git ls-remote --tags origin` ends at v1.1.0); `deploy-prod.yml` also runs on `workflow_dispatch`, which is probably how v1.2.0 was deployed, so the exact production commit is an inference until confirmed from the deploy history. Production Supabase is free tier on t4g.nano, no PITR.
- What v1.3.0 changes for learners and consumers: 0081 makes one official attempt the platform default (was 3) and adds `pass_required`; completion detection becomes AU-level only (#118), so KIVO cmi5 modules stop completing at the first Next; cmi5/xAPI completions start firing the CRM completion webhook for official attempts (#148); 0078 switches every enabled tenant LRS feed to the `ambak-v1` profile the moment the code deploys, and `raw` can only be set after 0078 exists; step 0 serves each attempt its own version.
- `cron.yml` schedules `/api/cron/report-card-refresh` every 15 minutes; the route exists only on main, so the "Scheduled crons (prod)" workflow has been red since 2026-10-07. The "Ops watchdog (prod)" is red because the `lrs-forward` heartbeat looks stale: GitHub runs about 23 of about 508 scheduled cron invocations a day. `CRON_CADENCE_MIN` in `app/api/ops/health/route.ts` lists 6 of the 10 scheduled jobs.
- `pg_cron` is referenced nowhere in the repository. `after()` is unreliable on both staging targets (Workers free plan CPU cap; Cloud Run deploy leaves CPU throttling on). No lifecycle spec and no unit test runs in any workflow; the pr-checks e2e job is skipped on pushes to main; both suites target one staging URL and purge `qa-*` data first.
- The direct-upload spec 44 has never run in CI (skipped unless `DIRECT_UPLOAD_E2E=1`, asserts the `r2` driver by default).

## Decision

### 1. Pre-tag checklist for v1.3.0 (Claude prepares; owner runs anything that touches production)

1. Confirm the production commit from the head SHA of the last successful `deploy-prod.yml` run (Actions history) or the Cloudflare deployment metadata of `my-lms-prod`, and record it in the release notes, before any hotfix discussion.
2. Read-only production audit. The executor writes `ops/release-v1.3.0-audit.sql` (real selects only — head/count probes report missing tables as present; one presence probe per migration 0072–0098, including a `pg_constraint` probe on `course_versions` that names both `course_versions_course_id_version_number_key` and `course_versions_package_id_version_number_key` to settle whether the out-of-repo 0032 hotfix reached production), runs it on staging first, and the same file is the post-apply probe. The audit also covers: the storage-prefix gate SQL (ADR 0003 step 8) and both duplicate-pair queries; stored-bytes title/id versus `manifest_data` for every current version (ADR 0004 step 16, run by a read-only script against the production bucket); cmi5 attempts with `completed_at - started_at < 60 s` and completions with zero AU-level statements; enabled CRM webhooks per organisation; enabled `tenant_lrs_config` rows; and, if decision 6 is accepted, `validate_existing` for the current versions without a validation report. Added at acceptance (2026-10-16; acceptance condition b, with the staging results of ADR 0003 step 7a as the reference): the `course_versions` constraint state (which of the two named constraints exists, plus the two duplicate-pair counts, so the audit says whether `0032_course_versions_unique_per_package.sql` is a no-op or a real change on production); one object probe per migration 0072–0097 (real selects against named objects, for example `content_scopes` for 0096, `organizations.enforce_content_mapping` and `manager_coverage` for 0097), so the first pending migration is a fact, not the `FIRST_CHECKED` inference; the absence of every planned 0098/0099 object before the sitting (`course_versions_storage_prefix_key`, `course_versions.conformance_level`, `course_attempts.is_preview`, `learning_sessions`, `package_certifications`), which the same file must then find present or still absent after it; every inactive package with an `in_progress` attempt, listing the attempt ids, because the launch rule of ADR 0004 step 9 (3) will abandon those at the learner's next launch once v1.3.0 is live (0 on staging; the owner sees the production list before the tag, condition a); and, per course, `courses.current_version_id` resolved to its package and compared with the manifest titles of the course's slots (the wrong-default class of ADR 0004 step 12a).
3. Rehearse 0032 (guarded), 0072–0097 and `0098_record_protection.sql` on a scratch Supabase project restored from last night's `pg_dump` (this is the restore drill of ADR 0003 step 4; a free Supabase organisation allows two projects, so the slot may need arranging). Run the audit SQL there; time the apply (expect 1–2 h on production). If the audit finds duplicate `storage_prefix` rows on production, the executor first writes `ops/release-v1.3.0-repoint.md` from the staging step-0 procedure (copy the version's objects to its own package-scoped prefix `courses/{courseId}/{packageId}/v{n}/`, verify the listing, then update `storage_prefix` on that row only) and the owner runs it before 0098; every repointed version goes in the incident ledger.
   Note (2026-10-18; owner decision 7 below, not an edit to this step): for v1.3.0 the rehearsal is a free local copy, not a scratch project: the migration rehearsal harness (`scripts/migration-rehearsal/`, run locally and by `.github/workflows/migration-rehearsal.yml`) and the owner's encrypted-dump restore drill. `docs/release/v1.3.0.md` §7.3 lists what this cannot prove; the production audit of step 2 is what catches the data-dependent failures.
4. Run spec 44 once on staging with `DIRECT_UPLOAD_E2E=1 EXPECTED_STORAGE_DRIVER=supabase`.
5. Apply on production in one sitting: 0032 (guarded; a no-op where the hotfix was already applied), 0072–0098. Verify with `ops/release-v1.3.0-audit.sql`.
6. Set `tenant_lrs_config.statement_profile = 'raw'` for each enabled configuration unless its consumer was told about `ambak-v1`.
7. `cron.yml` and `CRON_CADENCE_MIN`, in the BLUEPRINT §5.7 order (a schedule line fires on production as soon as it is on `main`; a cadence entry before its schedule pages the watchdog): remove the `report-card-refresh` line now (push to main). The v1.3.0 code carries the route and the `CRON_CADENCE_MIN` entries only for jobs whose schedules already fire and whose routes are already on production (`gamification-refresh`, `gamification-monthly`, `journey-nudges`). After the v1.3.0 deploy is verified (step 9), the `report-card-refresh` line is re-added in its own push to main; its cadence entry ships in the next tag.
8. Release notes for owner sign-off and the CRM consumer: one official attempt and `pass_required` (0081); cmi5 completion requires an AU-level statement (#118); cmi5/xAPI completions fire the completion webhook, official attempts only (#148); LRS `ambak-v1` profile (0078); abandoned attempts no longer read as in progress (ADR 0004); versioned delivery; a count of first-slide cmi5 completions from step 2 labelled as history (never rewritten).
9. Tag `v1.3.0` (deploys production); verify health, a learner launch, a cmi5 completion and the Report Card; then the D5 clean-up on production through app flows (ADR 0004 §5), only for the slots the step-2 bytes-versus-row and wrong-default checks flagged, with ledger entries: D5a (grandfather, default correction, zero restarts) first; D5b (closing attempts, deactivating slots) only on the owner's explicit go against the per-attempt list the audit produced (acceptance condition a). The tag itself waits for the owner to have seen the audit's list of in-progress attempts on inactive packages, because the launch rule of ADR 0004 step 9 (3) abandons those at the learner's next launch.
10. D4: the tag follows within about a week of a clean audit; if the audit is not clean, the tag is held. No v1.2.1 hotfix branch unless the owner funds about one executor-day to keep one warm; a hotfix would be a re-implementation on the 2026-09-17 tree, not a cherry-pick. No `v*.*.*` tag is ever pushed as a bookmark.

### 2. Scheduler for ALDS jobs (P5; replaces GitHub-driven schedules for new jobs)

11. The P5 migration runs `create extension if not exists pg_cron` and schedules by name (`cron.schedule('alds-ingest', …)`, `cron.schedule('guardian-reconcile', …)`) so re-applying on both environments upserts rather than duplicates. Each job function upserts `ops_heartbeats` itself; the `CRON_CADENCE_MIN` entry ships in the same tag. Order rule (inverts blueprint §5.7): apply the migration on production and verify `select jobname, active from cron.job` plus a fresh `ops_heartbeats` row, then push the tag with the cadence entry.
12. A nightly job deletes `cron.job_run_details` older than 7 days. A `security definer` view over `cron.job` in `public`, with a literal `grant select … to service_role`, lets ops-review verify parity.
13. Budget: each running job holds a direct connection and CPU on the nano instance; reconciliation is sampled and off peak. Staging has `OPS_EXPECT_CRONS` unset, so its gate is the manual `cron.job` check. Acceptance for ingest: "facts appear within one sweeper cadence"; pg_cron is the primary path on every environment; no inline `after()` dependency. No new `cron.yml` schedules (ADR 0002).

### 3. CI jobs

14. P0: `unit` job in `pr-checks.yml` running `npm run test:unit`, which runs every `tests/unit/*.test.ts` file separately (ADR 0003 step 15).
15. Before P4 starts (a P4 entry condition, `docs/ARCHITECTURE.md` §6): `lifecycle-nightly.yml` running an ALDS-tagged subset of `tests/bot/lifecycle` (00, 32, 33, 34, 43, 47, 48, 49, 50–53 from ADR 0003 and 0004, and the golden canary) against a chosen staging URL. Until it exists, each phase gate is "the executor runs `npm run test:lifecycle` against the URL and attaches the report". Never push to main while a staging harness runs (the purge).
16. Cloud Run staging needs an owner deploy (`scripts/cloud-run-deploy.sh`) before the step-0 specs can run there; if inline ingest is ever kept for latency, the deploy adds `--no-cpu-throttling` and `docs/CLOUD_RUN_STAGING.md` says so (not recommended; pg_cron is primary).

### 4. Cron noise

17. The `lrs-forward` staleness is a measurement artefact of GitHub's cron starvation, not a forwarding failure (the outbox is cursor-chunked; the sweeper catches up). It is recorded here and accepted until pg_cron replaces GitHub-driven schedules; no new `cron.yml` line is added. Moving `lrs-forward` itself to pg_cron (via `pg_net`) would be a separate ADR.

### Risks and protections

| Risk | Protection |
|---|---|
| 26–28 hand-applied files on a no-PITR production (0032 guarded, 0072 or 0073 through 0098) | rehearsal on a scratch project restored from the dump; one sitting; `ops/release-v1.3.0-audit.sql` before and after |
| Tenant LRS consumers receive a changed payload | `raw` per enabled config unless told; release note |
| CRM receives cmi5 completion webhooks for the first time | webhook count in the audit; CRM consumer sign-off item |
| Learners: one official attempt by default | release note; existing attempts unchanged; `attempt_requests` flow exists |
| A schedule fires before its route exists, or a cadence entry pages before its schedule | cron line removed now; re-added only after the v1.3.0 deploy is verified; its cadence entry in the next tag; pg_cron order rule |

## Consequences

- Production reaches parity with staging (code and schema) and gains step 0 and the P0 protections in one release; the two red workflows stop being red for the known reasons.
- Learners on production see the one-official-attempt rule and honest abandoned states; cmi5 completions become real completions.
- New scheduled work lives in the database, visible to ops through the heartbeat table and the parity view, instead of in a starved GitHub schedule.
- The owner's calendar is the critical path: audit, rehearsal, apply, tag, verify, clean-up.

## Alternatives considered

- Hotfix v1.2.1 with only the content fix: a rewrite on the 2026-09-17 tree (the fix depends on main-only code in `lib/courses/content-delivery.ts` and `isAboutAu`), its own spec run and a second tag; only worth it if funded.
- Keep ALDS jobs on `cron.yml`: starved (about 5 % of invocations run), red on prod until the route deploys, invisible to health unless listed.
- A dedicated scheduler Worker: plausible later; pg_cron needs no HTTP hop for plpgsql jobs and no extra deployment.
- Lifecycle nightly against the Workers staging with retries: tests whatever `deploy-staging.yml` last pushed, under the 10 ms CPU cap; acceptable fallback if no Cloud Run deploy key is granted.

## Decisions requested from the owner

1. D4: v1.3.0 within about a week of a clean audit; hold the tag otherwise; no v1.2.1 unless funded. Recommended: yes. Decided (owner, 2026-10-16): yes; "clean audit" includes the checks added at acceptance in step 2.
2. Lifecycle-nightly target. Recommended: Cloud Run staging with continuous deploy from main (`docs/CLOUD_RUN_STAGING.md` §6) and a second GitHub secret for its URL; otherwise the Workers staging with retries. Decided (owner, 2026-10-16): as recommended; the Cloud Run continuous deploy is an owner action still to be done, and the Workers fallback stands until it is.
3. `statement_profile` per enabled tenant LRS configuration. Recommended: `raw` unless the consumer has been told about `ambak-v1`. Decided (owner, 2026-10-16): `raw` unless the consumer was told.
4. Accept the `lrs-forward` watchdog noise until pg_cron lands rather than adding schedules or raising cadences now. Recommended: yes. Decided (owner, 2026-10-16): yes.
5. Fund about one executor-day to keep a v1.2.1 hotfix branch warm. Recommended: no. Decided (owner, 2026-10-16): no.
6. Add to the production audit (review suggestions, not in the reviewed plan): `validate_existing` for the current versions that have no validation report, and a listing baseline (path, size) per current version for a nightly reconcile. Recommended: yes for `validate_existing` (read-only, uses the existing route); the listing baseline only once the P5 reconcile job exists to consume it. Decided (owner, 2026-10-16): yes for `validate_existing`; the listing baseline with P5.
7. The rehearsal environment for step 3 (asked 2026-10-18: a free Supabase organisation holds two projects, and staging and production use both). Options offered in `docs/release/v1.3.0.md` §7: (a) a paid plan for the organisation that holds production and staging, (b) a free slot under another account, (c) pausing staging for the day, (d) a separate paid organisation for the day, or the fallback without a third project (an embedded-Postgres replay plus the encrypted-dump drill). Recommended then: (d). Decided (owner, 2026-10-18): the free local copy, "For the production practice run, I prefer the free local copy to avoid unnecessary costs." The rehearsal is the migration rehearsal harness (`scripts/migration-rehearsal/`, locally and in CI) plus the encrypted-dump restore drill; no scratch project is made for v1.3.0. ADR 0003 step 4's restore into a Supabase project and its prefix hash-compare are not part of it and stay open (`docs/release/v1.3.0.md` §7.3).

## References

- `.github/workflows/cron.yml`, `ops-watch.yml`, `pr-checks.yml`, `nightly-e2e.yml`, `deploy-prod.yml`, `deploy-staging.yml`, `backup.yml`
- `app/api/ops/health/route.ts` (`CRON_CADENCE_MIN`), `supabase/migrations/0050_ops_heartbeats.sql`, `lib/ops/heartbeat.ts`
- `supabase/migrations/0072…0097`, `0078_lrs_analytics_profile.sql`, `0081_revision_rule.sql`, `lib/lrs/config.ts`, `lib/lrs/enqueue.ts`, `scripts/check-migration-grants.mjs` (`FIRST_CHECKED`)
- `docs/CRM_INTEGRATION.md` §6 "Known limits" (says cmi5 completions fire no webhook; stale after v1.3.0, corrected by the executor in the release)
- `app/api/xapi/statements/route.ts` (webhook call), `lib/integrations/webhook.ts`, `docs/CRM_INTEGRATION.md`
- `docs/MIGRATIONS.md`, `docs/ops/backup-restore.md`, `ops/RUNBOOK.md` §2, §6.2, §8
- `docs/CLOUD_RUN_STAGING.md`, `scripts/cloud-run-deploy.sh`, `tests/bot/lifecycle/44-direct-upload.spec.ts`
- `docs/ambak-learning-data-standard/BLUEPRINT.md` §5.7, §6.3
- ADR 0003 (migration 0098, restore drill, unit job), ADR 0004 (D5 clean-up, audit check), ADR 0005 (P5 jobs, canary)

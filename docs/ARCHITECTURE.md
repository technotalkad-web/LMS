# Ambak University LMS — Architecture

Status: governing document. `CLAUDE.md` names this file and `docs/adr/` as the source of truth. Written 2026-10-15 against a89832f (`origin/main`) plus the local governance commit 31bddd5 (`CLAUDE.md`, `.claude/agents/architect.md`); updated 2026-10-16 at d2073a6 to record the acceptance of ADR 0002–0007, and on 2026-10-17 for ADR 0008 (decisions 0004/6 and 0004/7 taken; C and D accepted later that day with the migration renumbering of ADR 0008 decision 2; the ADR 0004 sign-offs 8 and 9 recorded). It says what the system is, which document rules which area, and where each structural decision is recorded. It does not repeat the design documents it points at. ADR 0002–0007 were accepted by the owner on 2026-10-16 on two conditions that bind every phase: (a) no learner attempt is restarted or abandoned until the owner gives an explicit go after seeing the per-attempt impact list; (b) production migration state is confirmed in the P1 read-only audit before any production apply. The section map (§5, second table), the roadmap (§6) and the decisions (§7) are in force; P0 implementation may start.

## 1. The system today

### Stack

- Next.js ~15.5 App Router, built for Cloudflare Workers by `@opennextjs/cloudflare` (fetch-only worker: no `scheduled` handler, so GitHub Actions drives the crons). `AGENTS.md`: this Next.js differs from older releases; read `node_modules/next/dist/docs/` before writing code.
- Supabase per environment: Postgres with RLS and tenant isolation, Auth (magic link, password, SAML), Storage (`course-content` bucket for packages, `public-assets` for thumbnails and branding), Edge Function `send-smtp`.
- A Cloudflare R2 storage adapter exists (`lib/storage/r2.ts`, migration 0077) but `STORAGE_DRIVER = "supabase"` on both environments (`wrangler.toml`), and every staging version has `storage_driver = 'supabase'` (the column reaches production with 0077). Steps 6, 7 and 9 of `docs/CONTENT_STORAGE.md` (copy to R2, flip the driver, empty the Supabase bucket) are not done; step 8's workflow was enabled early and copies the unused R2 bucket.
- Backups: nightly `pg_dump` of the production database to Backblaze B2 (`backup.yml`, which also overwrites a `latest/` pointer). The content backup (`content-backup.yml`) runs `rclone sync` from the unused R2 bucket and fails every night; production course packages have no scheduled backup today. A one-off snapshot script exists on branch `ops/storage-snapshot` (ADR 0003).

### Environments

| | Staging | Production |
|---|---|---|
| Supabase | project `zeaclbapadosqqttexxh`; at migration 0098 plus the 0032 hotfix since 2026-10-17: the owner hand-applied `0032_course_versions_unique_per_package.sql` (a no-op there) and `0098_record_protection.sql` in the SQL editor; the storage-prefix gate SQL returned 0 rows; the `package_validations` override columns are present; specs `50-record-guard` (9/9) and `52-integrity-check` (12/12) passed against staging on `main` afterwards; no 0099-or-later objects (history: verified 2026-10-16 at 0097, 0093/0096/0097 objects present, no 0098/0099 objects) | separate project; believed at migration 0071 (`scripts/check-migration-grants.mjs` says 0073 is the first pending; the P1 audit settles whether 0072 is applied); free tier, t4g.nano, no PITR |
| App | Workers `my-lms.mentora.workers.dev` (free plan, 10 ms CPU cap, random 1102), auto-deployed on push to `main`; Cloud Run trial project `lms-cloudrun-trial-01` against the staging Supabase, owner-run deploy, currently on the 2026-10-07 build | Workers `my-lms-prod`, deployed by tag `v*.*.*` or `workflow_dispatch` (`deploy-prod.yml`); runs code from 2026-09-17; no `v1.2.0` tag exists on `origin` |
| Crons | none scheduled (`OPS_EXPECT_CRONS` unset) | `cron.yml` POSTs `/api/cron/*`; `ops-watch.yml` probes `/api/ops/health` |
| Tests | `pr-checks` e2e and `nightly-e2e` run against the Workers staging URL and purge every `qa-*` org and `@example.test` user first | never |

Drift to close: production is 25–26 migrations and one month of code behind staging, including step 0 of the learning-data blueprint. ADR 0007 is the release that closes it.

### Roles

`organization_members.role` (enum `org_role`): `super_owner`, `admin`, `data_analyst`, `user`. `canManage` = super_owner or admin; `canViewReports` adds data_analyst (`lib/auth/permissions.ts`). `data_analyst` is RLS-plain: analyst-visible pages read with the service role after the permission check. A platform owner exists above organisations (migration 0021).

### Content

`courses` → `course_packages` (one per language slot: `language`, `display_name`, `is_active`) → `course_versions` (one folder `courses/{courseId}/{packageId}/v{n}/`, intended immutable but not yet enforced — objects are written with upsert and `storage_prefix` has no unique index, see ADR 0003; `upload_status`, `storage_driver`, `manifest_type` ∈ `scorm12 | cmi5 | xapi`). Packages come from KIVO (the in-house editor; cmi5 or SCORM export) and from third parties. SCORM 2004 and multi-AU cmi5 are not supported.

### Learning-data flow

1. Launch (`app/[org]/(learner)/courses/[courseId]/launch/page.tsx`): creates or resumes a `course_attempts` row; cmi5/xAPI launches mint a `cmi5_launch_tokens` row; content is served from the attempt's own version by `content/v/[versionId]/[...path]/route.ts` (step 0, #171). The legacy `content/[...path]/route.ts` is kept for one release.
2. Runtime writes: SCORM commits (`app/api/scorm/[attemptId]/commit`), xAPI statements (`app/api/xapi/statements`), xAPI State (`app/api/xapi/activities/state`). Every write is conditional on `status <> 'abandoned'` and answers 410 otherwise (`lib/attempts/abandon.ts`).
3. Attempt derivation: `lib/xapi/process-statement.ts` (completion only from AU-level statements: `launchedActivityIds`, `isAboutAu`), `lib/scoring/*` (migration 0081: one official attempt; `courseStatus()`).
4. Consumers: Report Card (`lib/manager`), CRM/Yoddha (`lib/integrations`: catalog, progress, learner-summary, completion webhook), journeys and XP (RPCs called from the write routes), question-analytics matviews `mv_course_interaction_breakdown` (0031) and `mv_course_interaction_top_wrong` (0035), built from `xapi_statements` only (the other 0031 report matviews read attempts), tenant LRS feed (`lib/lrs`: outbox, profile `ambak-v1`, sweeper behind `/api/cron/lrs-forward`).

## 2. Module map

| Path | Holds |
|---|---|
| `app/[org]/(learner)/` | learner pages: courses, launch, content routes, dashboard, journey, leaderboard, profile |
| `app/[org]/(admin)/` | admin pages: library, analytics, reports, attention, users, teams, settings, integrations, journey-admin |
| `app/api/` | route handlers: `courses/*` (upload, validate-package, packages, versions, activate), `xapi/*`, `scorm/*`, `integrations/*`, `cron/*`, `ops/health`, `org/*`, `super/*` |
| `lib/courses/` | `upload.ts` (multipart), `direct-upload.ts` (browser-direct; its own validation gate), `validation/` (`validate-package.ts`, `gate.ts`, `validate-stored.ts`), `content-delivery.ts`, `progress.ts` |
| `lib/xapi/`, `lib/scorm/` | statement processing, launch-token binding, runtime types |
| `lib/attempts/`, `lib/scoring/` | abandon, grants, requests; official-attempt policy, `courseStatus` |
| `lib/lrs/` | tenant LRS forwarding, enrichment, the `ambak-v1` profile, `uuid5.ts` |
| `lib/integrations/` | CRM API auth, progress, webhook |
| `lib/manager/`, `lib/attention/`, `lib/notifications/` | Report Card, Attention Center providers, email templates |
| `lib/storage/` | `supabase.ts`, `r2.ts`, `keys.ts` |
| `lib/alds/` (planned; accepted, built in P3/P4) | ALDS types, rules bundle, launch contract, ingest (ADR 0005, 0006) |
| `supabase/migrations/` | `0001…0098` on `main`: the hand-applied 0032 hotfix committed as `0032_course_versions_unique_per_package.sql` (its name on branch `fix/158-versions-unique-per-package`, made idempotent; ADR 0003 step 7) and `0098_record_protection.sql` (P0; ADR 0003 step 8). Numbering in force (ADR 0008 decision 2, owner 2026-10-17): 0099 = the `package_validations` write guard (ADR 0008 C, not yet written), 0100 = alds core (P4), 0101/0102 = P5; details in §6. Conventions in `docs/MIGRATIONS.md` |
| `tests/unit/` | seven standalone `tsx` test files, not yet run in CI |
| `tests/e2e/` | the `pr-checks` suite (its global setup purges `qa-*` data) |
| `tests/bot/lifecycle/` | lifecycle specs `00…49`, run by hand with `npm run test:lifecycle` |
| `scripts/` | `check-migration-grants.mjs` (CI), `cloud-run-deploy.sh`, `migrate-content-to-r2.mjs` |
| `.github/workflows/` | `pr-checks`, `deploy-staging`, `deploy-prod`, `cron`, `ops-watch`, `ops-review`, `backup`, `content-backup`, `nightly-e2e`, `rls-audit` |
| `ops/RUNBOOK.md`, `docs/` | operations and the design documents listed in §5 |

## 3. Principles

1. Migrations are applied by hand in the Supabase SQL editor, staging first, then production. Never the Supabase CLI: it is linked to production.
2. Every new table or view gets RLS (deny-all or a scoped policy) and literal grants in the same migration; every new function gets explicit execute grants. `scripts/check-migration-grants.mjs` enforces the table/view grant part in CI (from 0073); RLS and function grants are checked in review.
3. Learner history is never rewritten or deleted: attempts, statements, stored package bytes. Correction happens through new rows, new versions, pointer changes and labels.
4. Production is owner-run: migrations, release tags, Cloud Run and editor deploys. Every production action is explained before it happens. A `v*.*.*` tag deploys production; never push one as a bookmark.
5. Staging first. No test or seed data on production. No email to real learners from tests.
6. Deploy-safe in both orders: code tolerates a missing column; a `cron.yml` schedule line ships only after its route is live on production, and a `CRON_CADENCE_MIN` entry only after its schedule fires.
7. Folder structure, module boundaries and patterns change only through an ADR.

## 4. Governance

- Fable 5.1 decides (the `advisor` tool and the `architect` agent in `.claude/agents/architect.md`); Opus 5.5 codes from the plans. The architect writes only this file and `docs/adr/`.
- The advisor is consulted before schema changes, new modules or folders, login/roles/permissions changes, API changes, new libraries or integrations, anything about grading, privacy or data, when the same error happens twice, and before a big task is declared finished.
- Decision flow: the architect writes an ADR as Proposed → the owner accepts or changes it (steps individually, ADR 0001 decision 2) → the ADR is marked Accepted → the executor builds from it → the verification named in the ADR runs. An accepted ADR is never rewritten; a later ADR supersedes it.
- If advice or a request conflicts with this file or an accepted ADR, work stops and the owner is asked.

## 5. Which document governs which area

| Area | Authoritative document | Amended by |
|---|---|---|
| Learning data, packages, Guardian, question analytics | `docs/ambak-learning-data-standard/BLUEPRINT.md` (v2, 2026-10-13) | ADR 0002–0006 (section map below) |
| KIVO step-0 engine patch | `docs/ambak-learning-data-standard/KIVO-P2-P3.md` | ADR 0006 (folded into engine release A) |
| Content storage and delivery | `docs/CONTENT_STORAGE.md` | ADR 0003 (backup source), ADR 0004, ADR 0008 D (accepted 2026-10-17: no reused version folders, `--min-age` and a conflict summary in `content-backup.yml`, `--fast-list` kept) |
| Migrations | `docs/MIGRATIONS.md` | — |
| CRM / Yoddha integration | `docs/CRM_INTEGRATION.md` | ADR 0004 step 11 (abandoned attempts excluded from progress and learner-summary), ADR 0005 decision 3 (optional `analytics_tier` on the catalog endpoint), ADR 0007 (release notes; §6 "Known limits" says cmi5 completions fire no webhook, which v1.3.0 makes stale and the executor corrects in that release), ADR 0008 B (`version_id` = the default slot's current version; `available` also requires that slot to be active) |
| Operations, backups, DR | `ops/RUNBOOK.md`, `docs/ops/backup-restore.md` | ADR 0003 (restore = pg_dump), ADR 0007 |
| Scoring and official attempts | `docs/ATTEMPT_SCORING.md` | — |
| Cloud Run staging | `docs/CLOUD_RUN_STAGING.md` | ADR 0007 |

Blueprint sections under the future-first profile (ADR 0002). In force since 2026-10-16 (ADR 0002–0007 accepted); where this map and the blueprint differ, this map governs.

| Section | Status |
|---|---|
| §0 prerequisites | Merged (#170, #171) and deployed to the Workers staging; specs 47/48/49/32 pass locally on a89832f (20/20); the blueprint's step-0 gate (green on Cloud Run staging) waits for the owner's Cloud Run deploy. The P2/P3 KIVO patch becomes part of engine release A (ADR 0006). Reaches production with v1.3.0 (ADR 0007). |
| §1 identity | Kept: qid/oid/courseUlid, IRIs, extensions. Cut: §1.5 Level 1 identity, `legacyIds`, the legacy-object-id extension. |
| §2 package contract | Amended (ADR 0004, 0005): of the new rules only the cross-course collision blocks an upload (the existing `unplayable` verdict still blocks); U-rule failures set the tier; U4 script check is informational; no quarantine (there is no publish state); U6 cut; U7 kept; the manifest gains pools and an author-declared language (ADR 0006). |
| §3 registrations | §3.1–3.2 deferred to P6; registration = attempt id. The blueprint's 0098 as written is split: "alds core" only, numbered 0100 since ADR 0008 decision 2 (written as 0099 in ADR 0003 and 0005; 0099 is now the `package_validations` write guard); `served_version_id` cut. §3.3 replaced by the P0 launch-time handling (ADR 0004 step 9). |
| §4 launch contract | Amended (ADR 0006): LaunchData stored in `xapi_state`, AU id as a pure function, no launch RPC; the SCORM session token is cut with SCORM journaling. |
| §5 gateway | §5.1–5.2 deferred to P6 with an evaluate/enforce split, except C0–C4 and the SCORM session token, which are cut; §5.3 kept for legacy id-less statements in P0 (ADR 0003 step 6); §5.4 split: `guardian_findings` and `guardian_runs` move to P5 (ADR 0005 step 13), the SCORM journal tables are cut, `guardian_quarantine`, `guardian_events` and `guardian_proposals` are deferred to P6; §5.5–5.6 deferred; §5.7 amended: pg_cron named jobs, and the cadence-after-schedule order for GitHub crons (ADR 0007). |
| §6 catalogue and facts | Trimmed per P5 (ADR 0005): catalogue from the manifest only, `question_catalogue_aliases` and `question_families` cut with Level 1, xAPI facts only, `quiz_runs` refuses duplicates, population rules carry a tier key; §6.3 ingest runs on pg_cron, not `after()`. |
| §7 reconciliation | Keep R3 (keyed on `course_version_id`, not the cut `served_version_id`), R6 (all attempts), R7, R8 (xAPI only), R10, R11, plus digest re-verification; R1, R2, R4, R5, R9 and R12 are cut or deferred with registrations, strict sessions and the gateway. |
| §8 defect mitigation | §8.1 legacy pre-pass cut, R10 grammar parser kept; §8.2 SCORM journaling cut. |
| §9 rollout | Superseded by the roadmap in §6 of this file; its spec numbers 50–56 are reassigned (50–53 are the P0 specs of ADR 0003 and 0004). |
| §10 defaults | 1 (`hi-Latn`) kept only as a BCP 47 value an author may declare in `alds-manifest.json` (ADR 0006 step 11), compared with the slot by primary subtag; no LMS slot code (ADR 0004 step 6). 2 (grace period) deferred with the gateway; 3 deferred with registrations; 4 (preview) kept; 5 (`qcode`) deferred with the catalogue UI; 6 (read-back, R12) cut; 7 (per-org strict flip) and the blueprint's `0102_retire_v1_question_views.sql` (§9 step 7) cut, the cut item keeping its name without a number, because 0102 now means the second P5 migration (ADR 0008 decision 2); 8 unchanged (out of scope). |

## 6. Roadmap

In force since 2026-10-16 (ADR 0002–0007 accepted). Status as of 2026-10-17: P0 in progress (D5a on staging reported done by the owner on 2026-10-17, its Framework-default leftover closed by ADR 0008 step 16; D5b waits for the owner's go); P1–P5 not started; P6 conditional. Both acceptance conditions apply to every phase: no attempt restarted or abandoned without the owner's go after the per-attempt list, and no production apply before the P1 audit confirms production's migration state.

| Phase | Contents | ADR | Production release | Gate | Status (2026-10-16) |
|---|---|---|---|---|---|
| P0 | Protect and preserve: content backups, no statement overwrite, write-once versions (reserve-first upload), delete guard, collision block with super_owner override, launch-time slot handling, abandoned-attempt visibility, unit job in CI, 0032 committed, per-version restart action and explicit course default (ADR 0008 A and B, decided 2026-10-17); D5a on staging (grandfather upload of the corrected Hindi module, Framework course's two empty wrong slots deactivated; zero restarts; reported done 2026-10-17, the executor verifies the rows read-only; the Framework default moves to 2e404b48 through "Set as default" once ADR 0008 B is on staging); D5b on staging only on the owner's explicit go after the visibility fixes ship, through the ADR 0008 restart route | 0003, 0004, 0008 | v1.3.0 (with P1) | On staging: 0098 applied (storage-prefix gate SQL = 0 rows before apply); lifecycle 47, 48, 49, 32, 50-record-guard, 51-no-overwrite, 52-integrity-check, 53-launch-routing, the ADR 0008 cases in 34-version-modes and 54-course-default green; the pr-checks `unit` job green, including the scoring-status abandoned cases; staging and production Storage snapshots present in B2 and `content-backup.yml` green for one night | In progress; D5a reported done 2026-10-17 (rows to verify); D5b gated |
| P1 | Production release v1.3.0: read-only audit (`ops/release-v1.3.0-audit.sql`, with the checks added at acceptance: constraint state, 0072–0097 object probes, absence of 0098/0099 objects, inactive packages with in-progress attempts, course default versus slot titles), rehearsal on a scratch project including the restore drill (moved here from P0, ADR 0003 step 4), 0032 (guarded) and 0072–0098 on production (0099, the `package_validations` write guard of ADR 0008 C, is never in this sitting: it follows v1.3.0, ADR 0008 step 20), tag, D5a on production for audited slots only (order per ADR 0008 step 16: Set as default before deactivating a wrong default slot; replace then Set as default on a wrong-bytes slot); D5b on production only on a separate owner go against the audit's per-attempt list | 0007, 0004 | v1.3.0 | post-apply probe file clean; release notes signed off; `report-card-refresh` schedule re-added only after the deploy is verified; the owner has seen the audit's list of in-progress attempts on inactive packages before the tag | Not started; blocked on the P0 gate and the audit |
| P2 | KIVO engine release A (parallel, KIVO repo, owner redeploys the editor) | 0006 | — | every-kind fixture with statement-shape assertions passes on Linux chromium | Not started |
| P3 | ALDS rules as code (`lib/alds/rules`, hashed bundle, golden fixtures) | 0005 | — | golden fixtures pass in the pr-checks `unit` job | Not started |
| P4 | KIVO 2.0 export, LMS launch contract, Package Guardian and tier UI, shipped per environment together, on migration 0100 alds core (written as 0099 in ADR 0005 §4 and ADR 0006 step 17; renumbered by ADR 0008 decision 2); removal of the legacy `content/[...path]` route | 0005, 0006, 0008 (numbering) | v1.4.0 | Entry condition: `lifecycle-nightly.yml` running (ADR 0007 step 15). Exit: first Level 2 package certified on staging; nightly golden canary green | Not started |
| P5 | Certified question analytics (migrations 0101/0102, written as 0100/0101 in ADR 0005 step 13 and renumbered by ADR 0008 decision 2; trimmed incl. `guardian_findings`/`guardian_runs`, ingest, pg_cron, readers behind `question_analytics_v2`) | 0005, 0007, 0008 (numbering) | v1.5.0 | facts appear within one sweeper cadence; R-rules return 0 | Not started |
| P6 | Conditional: sandbox certification runner, evaluate/enforce gateway, registrations | 0005 (trigger stated) | — | only on its trigger | Conditional; trigger not met |

Migration numbering in force (ADR 0008 decision 2, owner 2026-10-17): 0098 = record protection (P0, on `main`); 0099 = the `package_validations` write guard (ADR 0008 C: code first on each environment, the file after; on production only after v1.3.0 is live, never in the P1 sitting); 0100 = alds core (P4); 0101/0102 = the P5 migrations. ADR 0002 decision 5, ADR 0003 decision 2 and step 10, ADR 0004 step 15, ADR 0005 §4 and step 13, ADR 0006 status line and step 17, ADR 0007 step 2 (the "0098/0099 object" probes) and ADR 0008 Alternatives considered (A) wrote alds core as 0099 and P5 as 0100/0101; they are superseded on numbers only by ADR 0008 decision 2 and are not rewritten. The blueprint's `0102_retire_v1_question_views.sql` stays cut and keeps its name without a number (§5, §10 row). ADR 0008 C and D have no phase row of their own: C is code plus 0099 as above; D is code plus the `content-backup.yml` change (ADR 0008 steps 22–25, `--fast-list` kept per the note under its decision 3).

Effort: 23–35 executor-days over 6–8 calendar weeks, bounded by owner events (about 8 migration applies, 3 tags, 2–3 editor redeploys, 3 or more Cloud Run deploys).

## 7. Owner decisions and their status

Owner decisions D1–D7 (the owner accepted the recommended answers on 2026-10-16; D5 was split at acceptance):

| # | Question | Answer | Status | ADR |
|---|---|---|---|---|
| D1 | "Reliable analytics" means KIVO cmi5 question analytics only; completions, Report Card, CRM and journeys are never tier-filtered | Yes | Accepted 2026-10-16 | 0005 |
| D2 | Integrity: block only on a cross-course KIVO id/title collision in the org (super_owner override with a mandatory reason through the mechanism of ADR 0004 step 3a, audited, raised in the Attention Center); warn and confirm on same-slot drift; script detection informational; uncertified packages still launch | Yes | Accepted 2026-10-16 | 0004 (launch rule restated in 0005) |
| D3 | Certification model: certified engine + static checks on stored bytes + ingest validation; observation revokes, never grants; in-editor export self-check; browser runner only on triggers | Yes | Accepted 2026-10-16 | 0005 |
| D4 | v1.3.0 within about a week of a clean audit (including the checks added at acceptance); no v1.2.1 hotfix fallback unless the owner funds about one executor-day to keep one warm | Yes | Accepted 2026-10-16 | 0007 |
| D5a | Now, zero restarts, on staging: upload TEST LMS.zip into the Hindi slot of Turning Escalations (7ff60dde) as a new version in grandfather mode, which also makes it the course default (the default was the Gujarati slot d4f05fac); deactivate the Framework course's two empty wrong slots (3b005ed1, 887d4aaf; 0 attempts) and make its correct Marathi version 2e404b48 the default; the grandfather-window risk is stated and accepted; the upload page's update-notification email is unticked | Yes | Accepted 2026-10-16; owner-run | 0004 step 13 |
| D5b | Later: close the listed in-progress attempts on 7ff60dde (three learners, three staff) and the Gujarati attempt, deactivate the Gujarati slot, targeted announcement to the three learners; failed and abandoned staff attempts untouched and logged; 9dcdad9b left as is, never re-activated; on production only for slots the P1 audit flags | Yes as the plan | Gated: runs only on the owner's explicit go after the P0 visibility fixes ship on staging (decision 0004/9 below: condition being met by the ADR 0008 Part 1 build, not yet verified) and the per-attempt list is re-read (condition a); separate go on production | 0004 step 14 |
| D6 | KIVO engine release A with the widened defect list; 2.0 requirements as listed | Yes | Accepted 2026-10-16 | 0006 |
| D7 | Object lock (immutability) on a dedicated B2 content bucket, retention at least 30 days | Yes | Accepted 2026-10-16; the exact retention is set by the owner at bucket creation | 0003 |

Other decisions requested in the ADRs (items marked "not in the reviewed plan" were added by the reviews). "Decided" means the owner accepted the recommended answer on 2026-10-16:

| ADR | # | Question | Answer | Status |
|---|---|---|---|---|
| 0001 | 1 | Confirm the ten-section template and the phase-scoped, steps-individually-acceptable rule | Confirm | Standing (ADR 0001 is accepted; changeable only by a superseding ADR) |
| 0001 | 2 | Align `.claude/agents/architect.md` with ADR 0001 decision 2 (owner edit) | Yes | Owner edit still to be made |
| 0002 | 1 | Confirm the not-doing list as binding scope | Yes | Decided |
| 0002 | 2 | The only Hinglish measure in P0 is the `display_name` relabel (no `hi-Latn` slot code) | Yes | Decided |
| 0003 | 2 | Migration numbering: commit 0032 as `0032_course_versions_unique_per_package.sql` (its original name); P0 = 0098; P4 = 0099 alds core; guardian migration split across P5/P6 | Yes | Decided after the numbering was verified (ADR 0003 step 7a); superseded on numbers only by ADR 0008 decision 2 (owner, 2026-10-17): 0099 = `package_validations` write guard, 0100 = alds core, 0101/0102 = P5 |
| 0003 | 3 | Pre-alds-core (now 0100; written as 0099) learner attempt = any attempt unless its user is currently staff; former members' attempts always block | Yes | Decided |
| 0003 | 4 | Delete-guard bypass = the service_role JWT claim (not a GUC plus purge RPC) | Yes | Decided |
| 0004 | 3 | Incident ledger location | `ops/INCIDENT_LEDGER.md`, ids and reasons only | Decided |
| 0004 | 4 | `display_name = 'Hinglish'` on Hindi slots that hold Hinglish | Yes, L&D action | Decided |
| 0004 | 5 | Second Attention Center provider for unpublished versions (not in the reviewed plan) | Yes | Decided |
| 0004 | 6 | D5b mechanism: a per-version restart action (new route plus Library action, P0) instead of re-running `force_restart`, which would also reset learners on the corrected version (raised at acceptance from the force-restart code; not in the inputs) | Yes | Decided (owner, 2026-10-17); ADR 0008 steps 1–8 |
| 0004 | 7 | Course default rule: `publishVersion()` repoints the course default only when the published slot already holds it; a deliberate change of default slot becomes an explicit admin action (raised by the wrong-default finding; not in the inputs) | Yes, small P0 change | Decided (owner, 2026-10-17); ADR 0008 steps 9–16 |
| 0004 | 8 | P0 spec changes under step 17: spec 47's second course retitled "QA ALDS47 Other Course" (the step 3 collision block refuses the old title); spec 32 gains the `?lang=en` → `?switch=en` redirect and the confirm-then-abandon assertions of step 9 (1); no assertion removed or weakened (raised at the P0 build; not in the acceptance inputs) | Approved | Decided (owner, 2026-10-17) |
| 0004 | 9 | Reset (abandoned) attempts never shown as "In progress" on any surface, widened from the five readers of step 11 to every affected screen and integration (raised at the P0 build; not in the acceptance inputs) | Yes, provided all affected screens and integrations are covered | Conditional (owner, 2026-10-17): an audit found 11 uncovered surfaces; fixes on `feat/adr-0008-restart-default` with ADR 0008 Part 1 (not merged); two DB-only items (`v_course_attempt_summary.latest_completion`/`attempt_count`, `mv_path_enrollment_status`) deferred to the next migration window; the CRM feed's attempt counts and first/last access include reset attempts by documented design. Condition being met by the Part 1 build; not yet verified; D5b's gate waits on it |
| 0008 | 2 | `package_validations` writes only by `service_role`, org admins read (policy split, column revokes, literal grants); code first, migration after, never in the pre-tag sitting; the next migration number, shifting ADR 0003's 0099/0100/0101 by one | Yes | Decided (owner, 2026-10-17): "Only the server should be allowed to write package validation results"; numbering in force: 0099 = this guard, 0100 = alds core, 0101/0102 = P5 (§6); the blueprint's cut 0102 is a different item (§5, §10 row) |
| 0008 | 3 | Content backup: aborted and swept uploads keep a `failed` row so no version folder is ever reused; `--min-age 1h`, a conflict summary and a checked comparison mode in `content-backup.yml`; `--exclude` lines for any pre-existing conflict | Yes | Decided (owner, 2026-10-17): "Failed uploads should reserve their version number to prevent storage-folder reuse"; operations note recorded under the answer: the nightly `rclone copy` keeps `--fast-list` (B2 bills one Class C transaction per directory listing; free tier caps Class B and C at 2,500 a day) |
| 0005 | 3 | `analytics_tier` on `/api/integrations/catalog` (not in the reviewed plan) | Yes, optional field | Decided |
| 0005 | 4 | Publish-on-certification default for Level 2 uploads (not in the reviewed plan) | No for now | Decided |
| 0006 | 2 | Fold the KIVO-P2-P3 patch into release A | Yes | Decided |
| 0006 | 3 | Second Pages project for 2.0 testing | No | Decided |
| 0006 | 4 | Guardian reason `launch_contract_missing` (review suggestion) | Yes | Decided |
| 0007 | 2 | Lifecycle-nightly target | Cloud Run staging with continuous deploy; else Workers with retries | Decided; the Cloud Run continuous deploy is an owner action still to be done |
| 0007 | 3 | `statement_profile` per enabled tenant LRS configuration | `raw` unless the consumer was told | Decided |
| 0007 | 4 | Accept the `lrs-forward` watchdog noise until pg_cron lands | Yes | Decided |
| 0007 | 5 | Fund about one executor-day for a warm v1.2.1 branch | No | Decided |
| 0007 | 6 | Audit additions: `validate_existing` and a listing baseline (not in the reviewed plan) | Yes for `validate_existing`; baseline with P5 | Decided |

## 8. Verification map

| What | Proof | Runs where |
|---|---|---|
| Typecheck, lint, migration grants | `npm run typecheck`, `npm run lint`, `node scripts/check-migration-grants.mjs` | `pr-checks` on every push |
| Cross-tenant RLS | `rls-audit.yml` | migration PRs and weekly |
| Core e2e | `tests/e2e/` (`npx playwright test`) | `pr-checks` on non-main pushes and PRs; `nightly-e2e` 04:00 UTC |
| Step 0 (versioned delivery, abandoned terminal, org scope, language switch) | `tests/bot/lifecycle/47`, `48`, `49`, `32` | by hand (`npm run test:lifecycle`) until the lifecycle nightly exists (ADR 0007) |
| P0 record protection and integrity | lifecycle `50-record-guard`, `51-no-overwrite`, `52-integrity-check`, `53-launch-routing`, plus the per-version restart cases in `34-version-modes` and the course-default spec `54-course-default` (ADR 0008 step 17, which amends the placement in ADR 0004 step 17; the lifecycle-nightly subset of ADR 0007 step 15 becomes 50–54); `tests/unit/statement-id.test.ts`, `scoring-status.test.ts` | lifecycle by hand; `unit` job (`npm run test:unit`) in `pr-checks` (ADR 0003 step 15) |
| ADR 0008 C (`package_validations` write guard, code then migration 0099) | `52-integrity-check` cases of ADR 0008 step 21: an admin session's PostgREST PATCH of `overridden_at`, `verdict` and `report` on a pending blocked row is refused and the row unchanged; the super_owner override route still works; validate → upload on both paths still creates and links rows; `validate_existing` still records; a `user` session reads nothing; spec 44 unchanged; `rls-audit.yml` green | lifecycle by hand on the environment where the code and then 0099 are applied; `rls-audit.yml` on the migration PR and weekly |
| ADR 0008 D (no reused version folders, backup flags) | `44-direct-upload` with `DIRECT_UPLOAD_E2E=1` (ADR 0008 step 25): abort → row `failed`, prefix empty, the next upload takes the next number under a new prefix; multipart failure mid-way → `failed` row; reaper sweep → `failed`, not deleted; the Library hides failed rows; `content-backup.yml` `workflow_dispatch` input `dry_run` (`rclone copy --dry-run`, `--fast-list` kept per the ADR 0008 decision 3 note) as the rehearsal, then the next scheduled run's summary shows zero conflicts | lifecycle by hand (spec 44 is skipped without `DIRECT_UPLOAD_E2E=1`); the workflow `dry_run` is owner-dispatched, since it reads the production bucket |
| D5a on staging (zero restarts) | before: the six in-progress attempts on 7ff60dde listed in ADR 0004 step 12a; after the upload: the same six still `in_progress` on 7ff60dde, `courses.current_version_id` of both courses on the corrected version, no `asset_update` email sent | owner-run through the Library UI; the executor reads the rows and records the ledger entries |
| ALDS rules | golden fixtures under `tests/unit/` | `unit` job (ADR 0005) |
| First certified package, launch contract | KIVO every-kind fixture (KIVO repo); nightly golden canary | KIVO CI; lifecycle nightly (ADR 0006, 0007) |
| Production release | `ops/release-v1.3.0-audit.sql`, scratch-project rehearsal with the restore drill, the same file post-apply | owner, SQL editor (ADR 0007) |

## 9. Known hazards

- Every non-main push and every PR event runs the e2e purge against staging: all `qa-*` organisations and `@example.test` users are deleted. Never push while a staging harness is running.
- A `cron.yml` schedule fires on production as soon as it is on `main`, even when the route is not deployed there; `report-card-refresh` has been returning 404 since 2026-10-07 for this reason. The mirror hazard: a `CRON_CADENCE_MIN` entry whose schedule is not firing pages the watchdog.
- Any `v*.*.*` tag pushed to `origin` deploys production.
- The Workers staging is on the free plan: any SSR page can fail with error 1102 at random; Cloud Run is the deterministic staging target but needs an owner deploy.
- supabase-js head/count probes report a missing table as present; verify schema with real selects in the SQL editor.
- The Supabase CLI in this repository is linked to production; it is never used for migrations.
- Inside a `security definer` function or an FK cascade, `current_user` is the owner, not the caller; role checks in triggers use the JWT role claim (ADR 0003 step 10).
- `publishVersion()` (`lib/courses/upload.ts`) repoints `courses.current_version_id` on every upload and every "Make current" on any slot: the last published slot becomes the course default. This is how the Gujarati slot became the Turning Escalations default (ADR 0004 step 12a). ADR 0008 B (decided 2026-10-17) replaces this with the same-slot rule and an explicit "Set as default"; until it ships on an environment, an upload to any slot can still move that environment's course defaults, and the P1 audit checks each course's default against its slots. The Library cannot move a course default between slots until then: "Make current" is offered only on non-current versions.
- Both `force_restart` paths (replace-package and direct-upload finalize) abandon the in-progress attempts of every prior version of the package, not only the one being replaced (ADR 0004 step 14a). ADR 0008 A adds the per-version restart route; the two paths are unchanged.
- `package_validations` is writable by any org admin through PostgREST (0070 policy `for all`): the 0098 override columns, `verdict` and `report` can be set outside the super_owner override route, and both upload gates accept a `blocked` row whenever `overridden_at` is set. ADR 0008 C (accepted 2026-10-17; code first, then migration 0099; on production only after v1.3.0) makes writes service-role only; the hazard stands on an environment until C is there.
- `course_attempts` is writable by any learner through PostgREST with their own session (0002 policies `members create own attempts` and `members update own attempts`, never narrowed; no column restriction, no write trigger): a learner can PATCH `status`, `score`, `completion_status`, `success_status`, `completed_at`, `progress_pct` or `cmi_data` on their own rows (reviving an abandoned attempt, forging a pass) or POST a never-launched completed row; the launch page's attempt insert, its journey-tag update and the SCORM commit route still write with the caller client, so the policies cannot be dropped before that code moves to the service client. ADR 0009 (Proposed, 2026-10-17) proposes code first, then the policy drop plus revoke folded into 0099 with ADR 0008 C, together with the `v_course_attempt_summary` / `mv_path_enrollment_status` corrections deferred by ADR 0004 decision 9; the hazard stands on an environment until that is there (production has no attempt rows as of 2026-10-17).
- An aborted or swept upload deletes its `uploading` row, so the next upload to that package reuses the version number and folder; `content-backup.yml` (`rclone copy --immutable` into an Object-Locked bucket, 02:30 UTC, before the 03:00 UTC reaper) then fails every night on that folder. ADR 0008 D (accepted 2026-10-17; code only, plus the workflow flags) keeps such rows as `failed` so numbers are never reused; the hazard stands on an environment until D is there, and `content-backup.yml` keeps `--fast-list` (ADR 0008 decision 3 note).
- The Library upload page pre-ticks "Send update notification email to affected learners" when replacing a course; a corrective upload emails every assigned learner unless it is unticked (ADR 0004 step 13).

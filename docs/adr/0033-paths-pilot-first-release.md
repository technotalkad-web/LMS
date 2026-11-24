# 0033. The pilot release carries the Library and Learning Paths; Journeys, the CRM integration and path and journey test runs follow in release 2

Status: Accepted (owner, 2026-11-25: "all as recommended"), on the owner's answers to the six parts of section 3, all as recommended. The owner said yes in principle on 2026-11-20: "Yes. Launch Library + Learning Paths first. Move Journeys and CRM v2 to Release 2." No part is excluded (ADR 0001 decision 2). The six answers are recorded under "Decisions requested from the owner", in the note of 2026-11-25 under "Owner answers", not by rewriting this record. The acceptance approves no production action.
Date: 2026-11-20
Deciders: owner; architect (Fable 5.2)

This record changes accepted ADR 0024 at five points, for production's first release only. ADR 0024 is not rewritten and stays Accepted. Its text applies again as written when release 2 is on production. After the owner's answers, a dated note under ADR 0024 points here. An independent review of 2026-11-20 is applied; the table at the end lists each finding.

## Context

- **What ADR 0024 fixed.** The owner chose production's first release on 2026-11-13 (row R8): phases 1 to 7, 9a and P, in one sitting, with 0109 in it. The first learner waits for Yoddha to read CRM contract version 2 on a new key (D11, step 74a). The core has no feature flag (step 72).
- **Where the build stands.** By the notes under ADR 0024 (2026-11-14 to 2026-11-16), phases 1 and 2 are built and 0107 is on staging. Phase 2's last item, the 0108 paste on staging, and phases 3 to 9b are still to come.
- **What the owner asks now.** A first group of real learners on the Library and Learning Paths, before Journeys and CRM version 2 are finished.
- **Why a record is needed.** The cut conflicts with ADR 0024 at five points. A conflict with an accepted record is reported to the owner, not planned around (`docs/ARCHITECTURE.md` section 4). Section 2 lists the five points.
- **What the whole release waits for and the pilot does not.** Yoddha's written agreement and Yoddha's own move to version 2 (step 72, release dependencies 5 and 9). This team does not control either.
- **Production today.** It has no course and no learner (step 74a). The owner reports that it has no CRM key. The gate in section 6 reads the counts, the webhook address included.
- **No off-switch exists today.** Journeys and the CRM pages are part of every build. Each is open to the role that manages it.
- **This is not the release the owner declined (A4).** A4 put 0109 in a second sitting and left phases 6 and 7 for later. This record keeps D3: one sitting, 0109 whole, and the course and path share of phases 6 and 7 in the release.
- **The figures.** Days are ADR 0024's table days (step 72). Plan with one and a half times each figure, as step 72 says. Splits inside a phase are the architect's estimates and were not re-priced.

## Decision

Goal: production's first release serves the Library and Learning Paths, complete and proven, with every ADR 0024 rule for those two products in force.

Out of scope: any change to the official-attempt rule, the context rule, the completion writer, the views or migrations 0107 to 0109; any new migration; any role or permission change; the CRM contract itself; the Overview (phase 8) and journey activities (phase G), which were never in the first release; how many executors work side by side; the order of work after release 2.

### 1. The decision

Production's first release is called the pilot release here.

- It carries the Individual course product (the Library) and Learning Paths: launch, official attempts, completion, emails, rewards, grants, learner pages and reports.
- Journeys and the CRM integration stay in the code. On production two off-switches close their entry points (part 2).
- The single-course Preview with its delete screen is in the pilot release if the owner chooses part 3 (b).
- Path and journey test runs and their report pages are not built yet. They follow in release 2.
- The sitting keeps D3's order: 0105, 0106, 0107, the tag, 0108, 0109 (with 0112 where the owner places it, section 4). 0109 stays one file, journey SQL included.

What is left before the first learner, by phase:

| Part | The pilot's share | Table days | Follows in release 2 |
|---|---|---|---|
| Phase 2, last item | 0108 on staging. It follows 0112's staging paste and the green nightly counted from that paste (ADR 0024, note of 2026-11-16) | 0.25 | |
| Phase 3 Completion | Whole phase. One writer serves all three products | 8 | |
| Phase 4 Grants | Grants per context; the course and path delete routes with their dry-run dialog; the language delete's helper (step 85) | 3.5 of 4 | The journey share, the journey program delete route included |
| Phase 5 Rewards | Section F wired and tested (steps 33 to 36); the monthly award; spec 70. The LRS points filter is already built | 2 of 3 | The journey share: the badge period on the profile (step 35) |
| Phase 6 Learner pages | Dashboard and Library cards, the course page with its chooser, the step's "must pass" editor (step 46) | 5 of 7.75 | The journey page, the day editor, journeys for everyone, the "Journey completed" card, the "Started earlier" list |
| Phase 7 Reports | Course and path reports; 0109 whole | 9 of 11 | The journey report readers and pages |
| Phase P Preview | Part 3 (b): the delete screen and route, the course Preview Reports page, the "Kept earlier staff attempts" list, the cases of spec 75 that part 4 keeps | 3 of 8 | Path and journey report pages; test runs; spec 75's test-run and journey program cases |
| Phase 9a | The sitting's runbook, the first-learner gate, the restore procedure | 1.5 of 6 | CRM contract version 2 |
| Phase 9b | The staging proof, two green nights, the records | 2 of 2.5 | The journey share |
| New | The two off-switches, proven on production's settings | 2 | |
| **Total** | | **36.25** | **about 16.25** |

Phase 9b is not in the tag. As in ADR 0024, it comes after the sitting and before the first learner.

The review of 2026-11-20 named the items inside phases 4, 5 and P. No day figure changed. The splits are still the architect's estimates.

From the same starting point, ADR 0024's whole plan needs 50.5 table days to the first learner. The pilot needs 36.25. The cut saves about 14.25 table days before the first learner. It costs two switches, a second release and the five changes below.

### 2. The five points where this record changes ADR 0024

The section, step and row names are the reference. Line numbers are those of ADR 0024 on `main` on 2026-11-20 and only help today's reader.

| # | ADR 0024 says | Where | For the pilot release |
|---|---|---|---|
| C1 | The first release carries phases 1 to 7, 9a and P. The journey setting and Start journey are in it | Row R8 (line 1191); row R5 (line 1188); step 72, "What blocks production's first release" (line 723), the totals (line 706) and release dependency 2 (line 714); step 74, sitting item 4 (line 757) | The tag carries phases 1 to 3 whole and the course and path share of phases 4 to 7, 9a and P, as the table above. The journey setting and Start journey (R5) follow in release 2. Phase 9b's share follows the sitting, as before. D3 is kept |
| C2 | The notice addendum and Yoddha's written agreement are in hand before the tag. After the tag, a new CRM key reads version 2 and an old one version 1 (A17). Yoddha reads version 2 before the first learner | D11 (line 61); step 57, both gates (line 499); step 72, release dependencies 5 and 9 (lines 717, 721) and "The first learner is bound by D11" (line 725); step 74, safe deployment checks, before and after the tag, and sitting item 4 (lines 751, 757); step 74a, condition (3) (line 765); row R4 (line 1187) | One condition stands in their place: no CRM key, no webhook address, the CRM switch off. The after-tag check of a new and an old key is not run: no key can be made, and version 2 is not built. All of them return in release 2, before the first key is made (part 1; section 8, items 3 and 6) |
| C3 | "The core has no feature flag", and a list of what is flagged | Step 72, first paragraph (line 674) | The core still has none. The list gains two entries: Journeys and the CRM integration, entry points only (part 2) |
| C4 | Preview Reports, the test runs and the whole of phase P are in the first release. The test run is the answer to the owner's A21 request for a way to test a whole path or journey without official records | Row R12 (line 1195); A21 (lines 86, 1231) and section T (steps 87 to 89, from line 896); step 72, the phase P row and the totals (lines 698, 706); step 84, the flag `PREVIEW_REPORTS` on the whole Preview Reports section (line 858) | R12's own alternative is taken, a little narrower: the delete screen, the course Preview Reports page and the cases of spec 75 that part 4 keeps. Spec 75's journey program cases follow with the journey share of phase 4. These carry no flag. The flag covers only the path and journey pages and the test runs, which follow. The A21 request is met in release 2. Until then a whole path is tested on staging only (part 3) |
| C5 | Staging validation needs specs 68, 69, 70, 72 and 75, spec 73's cases and the changed specs. Phase 9b's gate is the whole of spec 73 | Row R19 (line 1202); step 73, "Staging validation" (line 738); step 72, release dependency 4 (line 716) and the gates of phases 6, 9a, P and 9b in the table (lines 696 to 701) | A narrower list for the pilot. The dropped cases return in release 2 (part 4) |

D11's purpose holds under C2: no consumer reads a strict version 1 row for a path learner, because no consumer reads at all. D11's letter changes: the first learner comes before Yoddha's move. Only the owner can allow that.

Step 72's reason holds under C3. It names "two decision rules on one table". The switches add no second rule. The context rule, the one official rule, the completion writer, the views and 0107 to 0109 run the same with either setting.

Parts 5 and 6 change nothing in ADR 0024. Part 5 applies its rule. Part 6 adds a pilot procedure on top of step 74a.

### 3. The six parts the owner answers

The owner's words of 2026-11-20 name Journeys and CRM v2. They do not name test runs. That deferral is inside part 3 and waits for the owner's own answer.

**Part 1. The CRM is off for the pilot: no key, no webhook address, the CRM switch off.**
- For the pilot this replaces the notice addendum, Yoddha's written agreement and Yoddha on version 2 (C2).
- What it means for people. The CRM is built as the front door (`docs/CRM_INTEGRATION.md:31-37`). With it off, an admin adds each pilot learner in the LMS, and learners sign in at the LMS address. Each pilot learner gets a first sign-in email from the LMS. It is sent through the organisation's own mail settings, so those are set and tested on production before learners are added.
- The lasting effect. A pilot completion is marked as dealt with when it happens, by the latch of ADR 0015 or the scope marker of ADR 0024 step 31. An organisation without an address is not looked at again (`lib/integrations/webhook.ts:43-45`). The mark is never cleared. So no webhook message is ever sent for a pilot completion, also after the CRM is turned on.
- How the CRM catches up. By reading the feeds (`lib/integrations/webhook.ts:17-18`). This is not verified for version 2, which is not built.
- Recommendation: yes. Each pilot learner is entered with the employee id and the email address exactly as the CRM holds them. The add-user form requires the id (`app/api/users/route.ts:96`), and the CRM's sync matches by it (`app/api/integrations/employees/route.ts:24-30`).
- Cost: the lasting effect above; hand entry of learners; a first sign-in email for each learner; one open question. What the sync does with a learner entered under a different id is not verified. It is tested on staging before the first key (section 8, item 3).
- A wrong id. An admin can correct it before the first key (`app/api/users/[userId]/route.ts`). If a sync makes a second account, the pilot record stays on the first account and cannot be moved, because no attempt is rewritten (section 7). So the roster check is a hard condition before the first key (section 8, item 3), not only a check before the gate.
- The roster check needs the employee ids and email addresses as the CRM holds them. Proposed: the owner supplies that list before the pilot learners are entered. It is the one thing the pilot needs from the CRM side. A yes to this part covers it.
- If no: the first learner waits for CRM version 2, the addendum and Yoddha's move, as ADR 0024 says.

**Part 2. Two off-switches on production: Journeys and the CRM integration.**
- ADR 0024 step 72 says the core has no feature flag. These two do not touch the core. They close entry points only.
- Absent means off. A switch is on only when its setting reads `on`, `1` or `true`, as `ALDS_P4` is read (`lib/alds/flag.ts`). A lost setting reads off. A copied one is caught by the `wrangler.toml` test of step 4 and by the deploy script's refusal for the production project.
- Production's settings carry neither switch. Staging and every test build set both on, so today's journey and CRM specs keep running. The Cloud Run deploy script sets both itself for staging, so a deploy cannot leave them out (step 4).
- Recommendation: yes. A procedure alone is not enough here. With the CRM on, a mistake would send learner data to another system. The LMS cannot take it back.
- Cost: 2 table days. The estimate was made for three switches and was not lowered. Two settings to remove later. The off state is what production runs, but no nightly build runs it; steps 5 and 10 cover that with a unit test and one hand run. wrangler warns about the two names at each production deploy. The warning is expected and is not silenced (step 9).
- If no: Journeys and the CRM stay reachable on production during the pilot, held back by the runbook's counts only.

**Part 3. Preview on production.**
- Either way, path and journey test runs and their report pages move to release 2. Until then a whole path is tested on staging only: by a test account with the learner role in a test organisation, and by the lifecycle specs (section T, options 2 and 3). Both write official rows on staging, which holds test data.
- What that costs on production. Staff cannot walk a path there without official records. A Start is official (row R6). A Preview from a path step opens the course outside the path and has no Continue (A21). So a production path's setup is first walked by a real learner. A mistake in the step order, a release date or a "must pass" setting can cost pilot learners official attempts, and only an admin's grant gives another one (section 7).
- The protection is a procedure. Before a path is assigned on production, its settings are checked against its staging copy, and each step's course is opened with Preview (step 9).
- The owner asked under A21 for a way to test a whole path or journey without official records. That request is met in release 2. A path test run inside the pilot is not priced here, because ADR 0024 priced path and journey test runs together. The owner can ask for that price before answering this part.
- (a) Off. Phase P is deferred whole. A third switch hides the single-course Preview that phase 2 built. Staff then cannot check a course on production without leaving a permanent official record: a staff Start is recorded like a learner's (row R6), and only Preview data may be deleted (section A, principle 5; step 76).
- (b) On for single courses, which is R12's own alternative: the delete screen and route with the dry-run summary and the audit row (step 99), the course Preview Reports page (step 84), and the cases of spec 75 that part 4 keeps.
- Recommendation: (b). R6 says staff "must select Preview mode" for testing. Three days cost less than official test records that can never be removed.
- Cost of (b): 3 table days, ADR 0024's own split, not re-priced. They are in the total above.
- Cost of (a): 3 table days less and a third switch that is not priced. The Preview check of each step's course before a path is assigned is then not possible either.
- Both options change staff habit: a Start becomes official. Until this release a staff launch on production counts as a preview by role. Under (b) staff have Preview. Under (a) they have no way to check a course without an official record.

**Part 4. A narrower staging validation for the pilot.**
- Kept, each by hand and in the nightly list: specs 68, 70 and 78; spec 69 as phase 3 leaves it; spec 73's course and path cases with their CSV and feedback cases; the cases of spec 75 that the table below keeps; every changed spec of step 64 (32, 34, 45, 46, 50, 53, 55, 58, 60, 61, 63, 64, 65 and the e2e consume-grant spec).
- Also kept: the lifecycle nightly green on the release candidate; the four A19 preconditions; the restore rehearsal (step 98); two green nights before the first learner.
- Added: the hand run on production's settings (step 10).
- Dropped until release 2: spec 72; spec 75's test-run cases and its journey program cases, as the table below; spec 73's journey cases (self-enrolment, and the journey parts of its CSV and feedback cases); spec 69's CRM, dashboard-card and "Started earlier" assertions.
- Recommendation: yes. Everything for courses and paths stays, except the path test run itself.
- Cost: the journey and CRM code on production has less fresh proof. It is switched off there. 0109's journey SQL reaches production before its readers do (risk 8). The path delete cases run on seeded rows, not on a real test run (step 6).

Spec 75, case by case. The cases are those of its row in ADR 0024 step 64.

| Case of spec 75 | In the pilot | In release 2 |
|---|---|---|
| Three staff roles press Preview on a course. The score shows in Preview Reports. Nothing official is written, also with tenant LRS forwarding on | Kept | |
| The same three press Start: a real attempt (R6) | Kept | |
| A path test run. A journey test run | | Moved |
| The manual delete with its dry run, its log row and the cases of step 99 | Kept, for course previews | Again for the rows of a real test run |
| Nothing is deleted automatically: an aged preview row, and an aged run row seeded by fixture | Kept | |
| An official attempt is unchanged after every delete | Kept | |
| A learner cannot open Preview Reports or the delete route | Kept | A learner cannot open a test run |
| Restarts and a Preview launch over open preview rows write nothing to the tenant LRS feed | Kept | |
| Staff rows in Learner Analytics and the Manager Report Card are the same before and after previews | Kept | |
| Course delete: with only previews; with a learner attempt; with a preview kept for review; with a by-role row; by a non-admin; straight through the Data API on an admin's session | Kept | |
| Path delete: with only preview data; with a learner attempt; with a preview kept for review; with a by-role row that carries an old path tag; by a non-admin | Kept, on seeded rows. A case whose seed fails step 6's rule moves to release 2 | Again on a real test run, with any case that moved |
| Journey program delete: every case | | Moved, with the journey share of phase 4 |
| Language delete: its three answers, and the delete that succeeds after the manual delete (step 85) | Kept | |
| The refresh answer carries no purge entry. A seeded preview kept for review is reported by the manual delete | Kept | |
| An analyst cannot delete (R25). No by-role row is ever removed (R26) | Kept | |

**Part 5. A pilot course may sit in both the Library and a path.**
- This is ADR 0024's rule, not a change to it (D4, D8, section L: "Course held individually and in a path"). The learner then has two results and two official attempts, one in each product. A Library completion never unlocks a path step. Points are paid once.
- Recommendation: yes. The proof walks one shared course both ways (specs 68 and 70).
- Cost: a learner who holds the course both ways completes it twice. The course page shows both lines and the chooser (phase 6). Admins are told before they assign.
- If no: a procedure keeps each pilot course in one product only. The rule still holds in the code.

**Part 6. Pilot paths are "Assigned only".**
- Why. One case of an "Everyone" path is still open: ADR 0024's note of 2026-11-15 (P2-6, line 2288) leaves it to "an owner or phase 6 decision".
- A path's visibility is a setting an admin can change (`app/api/learning-paths/[id]/route.ts:68-78`). So the rule needs a guard.
- (a) A count of "Everyone" paths. It must read 0 before the gate opens and at each weekly pilot check (section 6).
- (b) The save refuses "Everyone" for paths behind a third switch. Not priced. It widens part 2.
- Recommendation: (a). A slip shows at once and is undone with one save. No data leaves the LMS. Learners who started in that path keep their enrolment and their attempts (row R3).
- Cost of (a): a procedure, not code. A slip can last until the next check.
- The hold ends when the open case is settled and the owner says so.

### 4. Database changes

None. No migration, table, view, function, policy or grant is added or changed. 0107, 0108 and 0109 stay as ADR 0024 writes them. Where 0112 goes in the sitting is asked in ADR 0024's note of 2026-11-16 and is not answered here. If another file joins the sitting, a separate record says so.

The switches are settings of the deployment, not rows. They add no dependency on the schema. ADR 0024's departure from `docs/ARCHITECTURE.md` section 3, principle 6, for 0107 stands as written.

### 5. Steps for the executor

No step starts before the owner answers its part. Work that ADR 0024 already orders, and that is the same with or without this record, is not held by it: the 0108 paste on staging, phase 3, and phase 7's course and path reports with 0109.

1. **The switch modules (part 2).** New files `lib/journey/flag.ts` (`PRODUCT_JOURNEYS`, `journeysEnabled()`) and `lib/integrations/flag.ts` (`CRM_INTEGRATION`, `crmEnabled()`). Same reading as `aldsP4Enabled()`. Server only: no `NEXT_PUBLIC_` prefix, never imported by a client component. No new folder. Verified by `tests/unit/release-switches.test.ts`: absent, empty, `off` and any other text read off; `on`, `1` and `true` read on.

2. **Journeys closed when off.**

   | Entry point | File | When off |
   |---|---|---|
   | Learner menu item | `app/[org]/(learner)/layout.tsx` (it sets `showJourney`) | Not shown |
   | Admin menu item | `app/[org]/(admin)/layout.tsx` | Not shown |
   | Learner journey pages | `app/[org]/(learner)/journey/page.tsx`, `journey/certificate/page.tsx` | Not found |
   | Admin journey page | `app/[org]/(admin)/journey-admin/page.tsx` | Not found |
   | Program route | `app/api/journey/program/route.ts`, every method | 404 `journeys_off`; nothing written |
   | Enrolment route | `app/api/journey/enrollments/route.ts`, every method | 404 `journeys_off`; nothing written |
   | Hourly reminder job | `app/api/cron/journey-nudges/route.ts` | 200 with `skipped: "journeys_off"`; no email; its heartbeat recorded as ok |

   In the two routes the switch is read after the route's own sign-in and role check and before any write, so a caller without the role gets today's answer. The reminder job must answer 200: `cron.yml` fails a run on any other code. The launch page and the launch resolver are not touched. A journey launch needs an enrolment. An enrolment is made by the two routes above or by the audience trigger (`journey_auto_enroll`). All of them need a program, and only the program route makes one. The gate counts both. The routes phase 6 adds for journeys are built in release 2, with the check. Verified by step 5.

3. **The CRM closed when off.**

   | Entry point | File | When off |
   |---|---|---|
   | Every feed, the employee sync and the sign-in link | `lib/integrations/auth.ts`, `authenticateApiKey` | Answers as for a missing key, before any read |
   | Embedded-mode entry | `app/api/integrations/enter/route.ts` | 404 `crm_off`; no cookie set |
   | Embedded-mode exit | `app/api/integrations/exit/route.ts` | Unchanged. It only clears cookies |
   | Create a key | `app/api/org/api-keys/route.ts`, POST | 409 `crm_off`. List and revoke keep working |
   | Save a webhook address | `app/api/org/integration-settings/route.ts`, POST | 409 `crm_off` for an address. Clearing keeps working |
   | Admin page | `app/[org]/(admin)/integrations/` | One line says the integration is off in this release. The create forms are hidden |
   | Completion webhook | `lib/integrations/webhook.ts`, `fireCompletionWebhook` | Returns before the send |

   In the two settings routes the switch is read after the route's own sign-in and role check and before any write. The webhook check sits in the one function that sends, after its callers have taken the latch. So "off" behaves exactly like "no address": the completion is marked and nothing is sent. Verified by step 5.

4. **Settings.** Both switches are set `on` in every place that builds or runs the app for staging or for tests: the top-level `[vars]` of `wrangler.toml` (the staging Worker); `scripts/cloud-run-deploy.sh` (below); `scripts/e2e-in-runner.sh` and `scripts/lifecycle-nightly.sh`, beside their `ALDS_P4` line; and `scripts/run-unit-tests.mjs`, so that today's route tests for journeys, the CRM and the webhook stay green, while a test of the off state unsets them itself. For local development each developer sets them in their own untracked env file; `docs/CI-CD.md` and `docs/CLOUD_RUN_STAGING.md` say so. `[env.production.vars]` carries neither, with a comment that the absence is deliberate. Verified by a unit test that reads `wrangler.toml` and fails if either name is under `[env.production.vars]`. Release 2's record changes that test when it turns a switch on.

   The Cloud Run deploy script does not pass the switches as it passes `ALDS_P4`. A Cloud Run deploy replaces the whole list of settings, so a value the person deploying leaves out is switched off (the script's own note on `ALDS_P4`). Staging deploys are owner-run from a launcher outside this repository. So the script sets both switches `on` itself for any project that is not production, and prints the two values. For the production project it passes neither, and it refuses there if either name is set, as it refuses `ALDS_P4`. `ALLOW_PROD` is not changed. `docs/CLOUD_RUN_STAGING.md` says so. The unit test above also reads the script: both names are in the settings it passes for staging and in its refusal for production.

   wrangler then warns at each production deploy that the two names are in the top-level settings and not in production's. That warning is expected. It is not silenced by adding the names to production's settings (step 9).

5. **Tests for the switches.**
   - `tests/unit/release-switch-sites.test.ts`, a source scan. Every file of steps 2 and 3 calls its switch. Every route file under `app/api/journey/` calls `journeysEnabled()`. A route file under `app/api/integrations/` counts as closed when it calls `authenticateApiKey` or `crmEnabled()`. Five of the seven call `authenticateApiKey` today. `enter` gets its own call (step 3). `exit` is the only exception, and the test names it. So a new route that calls neither fails the test.
   - The same test holds the other side. None of these imports a switch module: a file under `lib/scoring/`, `lib/attempts/` or `lib/paths/`; either completion route; the launch page (`app/[org]/(learner)/courses/[courseId]/launch/page.tsx`); `lib/auth/course-access.ts`. This keeps step 72's reason true.
   - A unit test of `fireCompletionWebhook`: with the CRM off no request is made.
   - A unit test of the reminder job's answer when Journeys are off.

6. **Preview's share (part 3 (b)).** From ADR 0024 phase P: the delete screen and route with the dry-run summary, the confirmation, the changed-selection check and "Deletion history" (step 99); the course Preview Reports page (step 84); the read-only "Kept earlier staff attempts" list. These ship without a flag. `PREVIEW_REPORTS` stays the flag of the path and journey pages and the test runs, which release 2 builds.

   Phase 4's pilot share builds what the delete cases need: the course and path delete routes, and the language delete's helper (steps 40 and 85). The journey program delete route is not changed in the pilot. It stays as it is today and is closed on production by the switch (step 2).

   Spec 75 runs the cases that part 4's table keeps. No test run exists yet, so the path delete cases seed their own rows: a `preview_runs` row of kind `path` and a `path_run` preview attempt, inserted by the spec with the service role in its own lifecycle organisation. This is allowed. The path delete route and 0107's delete function are both in the pilot, 0107's shape check fixes what such rows look like, and ADR 0024's spec 75 already seeds rows by fixture. A seed must pass `tests/unit/attempt-insert-sites.test.ts` as that scan stands. No rule of it is loosened. A case whose seed cannot pass it, or that the database refuses, moves to release 2, and the owner is told. The by-role row with an old path tag may be such a case. Seeded rows do not prove that a real test run writes the same rows. Release 2 runs the path cases again on a real test run (section 8, item 4).

   Verified by `preview-purge-route.test.ts`, `preview-isolation-sites.test.ts`, `product-delete-order.test.ts` for the course and path routes, and the kept cases of spec 75.

7. **Phases 3 to 6, the pilot's share.** Built from ADR 0024's own steps, as the table in section 1. Each keeps its ADR 0024 gate without the cases part 4 drops. Phase 3's webhook cases run on staging, where the CRM switch is on.

8. **Phase 7 with 0109.** 0109 is written whole, with its reverse script and the timed refresh of step 71. Staging keeps Journeys on, so 0109 must not break a journey page that staging serves. If a 0109 object changes an answer that today's journey pages read, that reader change is built with 0109 and is reported to the owner as added work. Verified by specs 64 and 65, the timed refresh gate, per-product counts equal to counts by context, and a re-run of spec 69 after the 0109 paste on staging.

9. **Phase 9a's share.** The sitting's runbook under `docs/release/`, with the first-learner gate of section 6; the restore lines and the rehearsal procedure in `docs/ops/backup-restore.md` (steps 97, 98). Where ADR 0024 asks for the addendum and Yoddha's agreement before the tag, the runbook records instead: no CRM key, no webhook address, neither switch in production's settings. The runbook also carries these pilot lines:
   - The roster check. Each pilot learner's employee id and email address are checked against the list the owner supplies from the CRM's records (part 1). It is done before the learners are entered, again before the gate, and again before the first key (section 8, item 3).
   - The organisation's mail settings are set and tested on production before learners are added.
   - Before a path is assigned on production, its step order, release dates and "must pass" settings are checked against its staging copy, and each step's course is opened with Preview.
   - Admins are told that a course in both the Library and a path is completed once in each.
   - Staff check courses on production with Preview only, never with Start.
   - wrangler's warning about the two switch names is expected at the sitting's deploy. It is not silenced by adding the names to production's settings. The test of step 4 blocks that.

   Verified by the owner reading the runbook before the sitting.

10. **Staging validation on the release candidate.** Part 4's list. One new lifecycle spec proves production's settings. Its number is the next free one, confirmed against `main` when its pull request opens. It is run by hand against a production build of the candidate made with production's settings: `ALDS_P4` on, both switches absent. It runs on the staging database, never while another harness runs. It asserts: every entry point of steps 2 and 3 is closed; the reminder job answers its clean skip; one shared course is completed in the Library and in a path with two results and one paid completion; the completion is latched and a local listener receives nothing (the spec seeds the listener's address itself, because the settings route refuses it). It is not in the nightly lists, because the nightly builds with the switches on. It is run again after any change to a file of steps 2 and 3.

11. **The sitting (owner-run, explained beforehand).** ADR 0024 step 74, with D3's order and every gate of that step. 0112 is pasted where the owner places it (section 4). Before the tag the owner reads production's settings and the counts of section 6. After the deploy the owner checks with page loads only: the journey pages answer not found; the integrations page shows the off line and no create form; the deployed settings carry neither switch. No write call is made on production to test a switch. The page shows the value the deployed code reads. What the routes do with that value is proven in steps 5 and 10 on the same commit. ADR 0024's after-tag check of a new and an old CRM key is not run (C2).

12. **Phase 9b's share.** The staging proof with spec 73's course and path cases; two green nights; the full update of `docs/ARCHITECTURE.md` (ADR 0024 step 76), with the two switches and this record; the dated note that opens the gate.

13. **The weekly pilot check.** The counts of section 6, written into the runbook with the date.

### 6. The first-learner gate for the pilot, and the weekly check

Step 74a stays a procedure in the runbook, opened by the owner with a dated note. Its conditions (1), (2) and (5) are unchanged, with condition (2) reading part 4's list. Condition (3) reads, for the pilot: no CRM key, no webhook address, the CRM switch off. These are added: the Journeys switch off; no journey program and no journey enrolment; no "Everyone" path; the roster check of step 9 recorded. A condition that a separate record adds is not listed here.

The counts are read-only. The owner runs them in the SQL editor on production, before the gate opens and at each weekly pilot check. Each must read 0.

```sql
select count(*) from public.learning_paths where visibility = 'org_public';
select count(*) from public.journey_programs;
select count(*) from public.journey_enrollments;
select count(*) from public.org_api_keys where is_active;
select count(*) from public.org_integration_settings where webhook_url is not null;
```

A count above 0 goes to the owner before anything is changed. Nothing is repaired by hand.

### 7. What is not changed

- **The official-attempt rule.** One official attempt per learner per context. Review-only revision visits, counted and never scored. An extra official attempt only by an admin's grant, with the history kept. Tries only as the author configured. A final fail never becomes a pass (ADR 0014 and ADR 0017, as ADR 0024 scopes them).
- **The learning-context rule.** Every attempt row carries one context, fixed at insert. "Official" is derived by one rule. One function writes the completion side effects. No row moves between contexts.
- **Tracking and reporting per product.** Each product reads only its own records. Course reports show the Individual product only. Continue, the step lock, path progress, dashboards and reports follow the one path rule. This is the owner's sentence of 2026-11-11, and it binds the first learner as before.
- **The sitting.** D3's order, one sitting, 0109 whole. The four A19 preconditions. The restore rehearsal before the sitting.
- **Preview isolation.** A preview counts nowhere. Preview data is deleted only by hand, by an admin.
- **Learner history.** No attempt, statement or stored package is rewritten or deleted.
- **Roles, permissions and the CRM contract.** None changes. A closed entry point answers as shown in steps 2 and 3 and does nothing else.

### 8. What release 2 must still deliver

1. **Journeys.** The journey share of phases 4 to 7 and 9b, as the table in section 1. It includes the journey program delete route (steps 40 and 85), the badge period on the profile (step 35), and the journey setting with Start journey (R5, step 48). Also spec 73's journey cases; spec 69's dashboard-card and "Started earlier" assertions; spec 75's journey program delete cases.
2. **CRM contract version 2.** Steps 53 to 56; the dated notice addendum; `docs/CRM_INTEGRATION.md`; spec 72; spec 69's CRM assertions; `crm-guide-texts.test.ts`.
3. **Before the first CRM key is made.** Everything C2 set aside: the addendum and Yoddha's written agreement, version 2 live on production, and Yoddha's key a version 2 key. ADR 0024's after-tag check of key versions (A17) is run then. Production holds no old key, so release 2's record says how the version 1 half is proven. A hard condition: the roster check is done again and recorded, with every pilot learner's employee id and email address equal to the CRM's, and each difference corrected by an admin first. No key is made before that. Also the staging test of a learner entered by hand under an id the CRM does not hold, and a written line for Yoddha that pilot completions are read from the feeds and were never sent by webhook.
4. **Test runs.** The path and journey Preview Reports pages and the test runs (the rest of phase P), with spec 75's test-run cases, its path delete cases again on a real test run, any case that step 6's seeding rule moved, and the measured launch count of step 70. This meets the owner's A21 request.
5. **The full validation.** ADR 0024's list of step 73 again, whole, before a switch is turned on.
6. **Turning a switch on.** An owner-run production change, explained beforehand. Journeys: after items 1 and 5. The CRM: after items 2, 3 and 5.
7. **A record of its own.** Release 2 is planned in a new record: its sitting, if it needs one, and when the two switches are removed from the code. 0109 is whole so that release 2 needs no reporting migration over pilot records. That is not proven. A fault found later is fixed by a new migration file.
8. **The open "Everyone" path case** is settled before any path is opened to everyone.

### Risks and protections

| # | Risk | Protection |
|---|---|---|
| 1 | An entry point of Journeys or the CRM is missed | The source scan of step 5; the hand run on production's settings (step 10); the counts at the gate and each week |
| 2 | A switch is turned on by mistake | A lost setting reads off; only three values turn it on; a copied setting is caught by the unit test of step 4 and by the deploy script's refusal; production's settings are owner-run; the sitting reads the settings |
| 3 | The switches grow into a second rule | They close doors only. The scan of step 5 fails if a rule, launch, path or completion file imports one; step 5 lists the files |
| 4 | Pilot completions never reach the CRM by webhook | Stated to the owner in part 1. The feeds hold every result. Item 3 of section 8 comes before the first key |
| 5 | A learner is entered under an id the CRM does not hold | The roster check before the learners are entered and before the gate (step 9). An admin can correct an id before the first key. The roster check is a hard condition before the first key, with the staging test (section 8, item 3). A pilot record stays on the account that made it, so the check comes first |
| 6 | A learner is surprised to repeat a shared course in a path | The course page shows both results and the chooser. Admins are told. Specs 68 and 70 prove both results and one paid completion |
| 7 | A path is opened to everyone during the pilot | The count before the gate and each week. One save undoes it. Enrolments and attempts made meanwhile are kept, never deleted |
| 8 | 0109's journey SQL has a fault that the narrower validation does not show | Journeys are off and production holds no journey row. Spec 69 is re-run on staging after the paste. Release 2 runs every dropped case before the switch goes on. A fault is fixed by a new file |
| 9 | Staff test on production with Start and leave official records | Part 3 (b) gives them Preview. The runbook says staff use Preview only. Part 3 (a) leaves this risk open |
| 10 | The narrower list misses a fault in code that Journeys share with paths | Phase 3 is built whole. Spec 69 stays as phase 3 leaves it. Every changed spec stays. The rehearsal and the nightly stay |
| 11 | The reminder job turns production's cron or health red when off | It answers 200 and records its heartbeat (step 2), tested in step 5 |
| 12 | Grading | No grading rule changes. A course in two products gives two results by design, and each is official in its own product only |
| 13 | Privacy | With the CRM off, no learner data goes to the CRM. Preview data on production stays under the owner's conditions of 2026-11-13 |
| 14 | Existing records | No migration, no backfill, no delete. Production has no learner record at the sitting |
| 15 | A production path is set up wrongly, and pilot learners use official attempts on it | The path is tested on staging first. Before it is assigned, its production settings are checked against the staging copy and each step's course is opened with Preview (step 9). An admin's grant gives another attempt, with the history kept. Path test runs follow in release 2 |
| 16 | A staging deploy leaves a switch out, and the journey or CRM hand runs fail there | The Cloud Run deploy script sets both itself for staging. The unit test of step 4 reads the script |

## Consequences

- The first learner no longer waits for Yoddha, which this team does not control.
- About 14.25 table days less work stands before the first learner.
- Production carries less in the pilot: two products, with the other entry points closed.
- There are two releases, two validations and a second explanation to the owner.
- ADR 0024 reads differently at five points for one release. Each phase brief must name this record.
- Two switches live in the code until release 2's record removes them.
- Pilot completions are never sent to the CRM by webhook.
- Pilot learners are entered by hand, get a first sign-in email from the LMS and sign in at the LMS address.
- Until release 2 a whole path is tested on staging only. On production a path is first walked by a real learner.
- Journey SQL reaches production before the journey readers that use it.

## Alternatives considered

1. **The whole release first, as ADR 0024 stands.** No change to an accepted record and no switch. The first learner then waits for about 14.25 more table days and for Yoddha. This is what happens if the owner answers no.
2. **The release the owner declined on 2026-11-13 (A4).** Not proposed again. It splits the sitting and leaves reports and the chooser for later.
3. **Procedure only, no switch.** Rejected for the CRM and Journeys. With the CRM on, a mistake would send learner data to another system, and the LMS cannot take it back. A journey started by mistake would leave learner records, and those are never deleted. Accepted for "Everyone" paths (part 6), where a slip shows at once.
4. **A release branch without the journey and CRM code.** Rejected. It makes a second code line. The completion writer is shared, so the two lines would drift.
5. **A per-organisation switch stored in the database.** Rejected for the pilot. It needs a migration with RLS and grants, and a stored value can be changed from a page. A deployment setting cannot.
6. **A switch inside the rule, so the resolver refuses journey contexts.** Rejected. That is the second rule step 72 warns about.
7. **Refuse the webhook before the completion is marked.** Rejected. Every pilot completion would wait in the 15-minute sweep and be sent late, a few per run, once the CRM is on.
8. **Split 0109 and paste its journey SQL in release 2.** Rejected. D3 keeps 0109 whole in the one sitting, and a second reporting migration over pilot records is what one file avoids.

## Verification

- Each step of section 5 names its test.
- The pilot release is ready for its sitting when part 4's list is complete on the release candidate, the hand run of step 10 is recorded, and every gate of ADR 0024 step 74 holds.
- The gate opens when the conditions of section 6 are recorded in the owner's dated note.
- Each weekly check is a dated line in the runbook with the five counts.

## Decisions requested from the owner

The yes in principle of 2026-11-20 is on record. Six parts are still open. Section 3 gives each one in full.

| Part | Question | Recommended | Cost of the recommended answer |
|---|---|---|---|
| 1 | The CRM is off for the pilot: no key, no webhook address, the switch off | Yes | Pilot completions are never sent by webhook; learners are entered by hand, with the id and email as the CRM holds them; the owner supplies that list |
| 2 | Two off-switches on production, Journeys and the CRM, entry points only, absent means off | Yes | 2 table days; two settings to remove later |
| 3 | Preview on production: (a) off, or (b) on for single courses with its delete screen | (b) | 3 table days; no path test run on production until release 2, so a setup mistake on a production path can cost pilot learners official attempts that only a grant replaces |
| 4 | The narrower staging validation for the pilot | Yes | Journey and CRM cases are proven again only in release 2 |
| 5 | A pilot course may sit in both the Library and a path | Yes | Two results and two official attempts for that learner; points once |
| 6 | Pilot paths "Assigned only": (a) a count that must read 0, or (b) a third switch | (a) | A procedure, not code; a slip can last until the next check |

### Owner answers

One line per part. Nothing is built for a part before its line is filled.

- Part 1, the CRM off for the pilot (yes or no):
- Part 2, two off-switches on production (yes or no):
- Part 3, Preview on production ((a) or (b)):
- Part 4, the narrower staging validation (yes or no):
- Part 5, a pilot course in both the Library and a path (yes or no):
- Part 6, pilot paths "Assigned only" ((a) or (b)):

**Note 2026-11-25 (the owner's answers to the six parts; acceptance).** The owner answered all six parts on 2026-11-25, in chat. The reply was passed on to the architect as "all as recommended". This note stands as the six filled lines above. Those lines and the rest of the record are not edited. Where the record says the parts are open or not answered yet, this note is the current text.

- Part 1: yes. The CRM is off for the pilot, and the owner supplies the roster list.
- Part 2: yes. Two off-switches.
- Part 3: (b). Preview is on for single courses, with its delete screen. Path and journey test runs follow in release 2.
- Part 4: yes. The narrower staging validation.
- Part 5: yes. A pilot course may sit in both the Library and a path.
- Part 6: (a). A count of "Everyone" paths, which must read 0.

What may start. Steps 1 to 10 of section 5 are no longer held by an open part: steps 1 to 5 (part 2), step 6 (part 3 (b)), steps 7 and 9 (the pilot's share and the runbook) and step 10 (part 4's list, on the release candidate). Step 8, and phase 3 inside step 7, were never held. Each keeps ADR 0024's phase order and its own gate. Step 11, the sitting, is not opened by this note: the answers approve no production action, and the sitting stays owner-run and explained beforehand. Steps 12 and 13 follow the sitting. The owner's roster list is due before the pilot learners are entered (part 1). These answers do not settle 0112's place in the sitting (section 4). The dated note under ADR 0024 that points here is written with this note.

## References

- ADR 0024, `docs/adr/0024-three-independent-learning-products.md`: D3, D4, D8, D11; section A; section F (steps 33 to 36); steps 31, 40, 46, 48, 57, 64, 72, 73, 74, 74a, 76, 84, 85, 98, 99; section L; section T (steps 87 to 89); rows R3, R4, R5, R6, R8, R12, R19; decisions A17 and A21; the notes of 2026-11-15 (P2-6) and 2026-11-16 (step 16).
- ADR 0001 decision 2 (parts answered one by one). ADR 0014 and ADR 0017 (the official attempt). ADR 0015 (the webhook latch).
- `docs/ARCHITECTURE.md` section 3 (principles 3, 5, 6 and 7) and section 4.
- `docs/CRM_INTEGRATION.md`; `docs/MIGRATIONS.md`; `docs/CLOUD_RUN_STAGING.md`; `lib/alds/flag.ts`; `lib/integrations/auth.ts`; `lib/integrations/webhook.ts`; `wrangler.toml`; `scripts/cloud-run-deploy.sh`; `tests/unit/attempt-insert-sites.test.ts`; `.github/workflows/cron.yml`.

## Review, 2026-11-20

An independent review read this record on 2026-11-20. Every finding was checked against the code and ADR 0024. None was rejected. One suggested sentence was not used (row 15). No day figure and no recommendation changed.

| # | Finding | What was done |
|---|---|---|
| 1 | Must fix. The kept list named spec 75's delete cases as a whole, but some need work the pilot defers | Phase 4's pilot share names the language delete's helper. Part 4 lists spec 75 case by case. Program delete and test-run cases move to release 2. Path delete cases stay on seeded rows, with a fallback (step 6; section 8, items 1 and 4) |
| 2 | "A copied or lost setting can never turn a product on" was too strong | Part 2 and risk 2 now say: a lost setting reads off; a copied one is caught by the test of step 4 and by the deploy script's refusal |
| 3 | A Cloud Run staging deploy could leave both switches out | Option chosen: the deploy script sets both itself for staging, prints them, and passes neither for production. The unit test reads the script (step 4; risk 16) |
| 4 | The production check after the deploy should make no write call | Option chosen: page loads only. No write call is made on production to test a switch (step 11) |
| 5 | ADR 0024's after-tag check of key versions was replaced without being named | Named in C2. It returns before the first key (section 8, item 3) |
| 6 | Row R5 puts the journey setting and Start journey in the first release, and C1 did not name it | R5 added to C1, to section 8, item 1 and to the references |
| 7 | The cost of having no path test run on production was understated, and A21 was not named | Part 3, C4, the decision table, risk 15 and the consequences state the cost. Step 9 adds the settings check and the Preview check before a path is assigned. Part 3 says what "tested on staging" means. Part 3 also says the owner can ask for the price of a path test run inside the pilot; that line goes beyond the finding |
| 8 | The lasting effect of a wrong employee id was understated | Part 1 says an admin can correct an id before the first key, and that a pilot record stays on the account that made it. The roster check of id and email is a hard condition before the first key (section 8, item 3; risk 5) |
| 9 | The source scan's rule for integration routes was not exact, and the launch files were not listed | Step 5 says when an integration route counts as closed and names `exit` as the only exception. The launch page and `lib/auth/course-access.ts` join the files that must not import a switch |
| 10 | Phase 5's split was too vague | The table names the pilot's items, notes that the LRS points filter is built, and names the journey share |
| 11 | The audience trigger also makes journey enrolments | Step 2 now names it. The conclusion holds: only the program route makes a program |
| 12 | Two sentences about a CRM mistake were unclear and partly inaccurate | Reworded in part 2 and in alternative 3. Alternative 3 also gained one sentence on why a procedure is not enough for Journeys; that sentence goes beyond the finding |
| 13 | Leaving the switches out of production's settings brings back a wrangler warning | The warning is stated as expected, in part 2, step 4 and the runbook lines of step 9 |
| 14 | The hand run should copy all of production's settings | Step 10 says: `ALDS_P4` on, both switches absent |
| 15 | Two dependencies of the CRM-off path were not stated | Applied in part. Part 1 names the first sign-in email and proposes the owner as the supplier of the CRM's list. The suggested sentence about the sender was not used: learner mail goes through the organisation's own mail settings, and step 9 has them set and tested first |
| 16 | The change of staff habit was listed under option (a) only | Part 3 now says both options change it, and what each leaves staff with |
| 17 | The sitting order and the first table row left out 0112 | Section 1 and step 11 point to section 4 for 0112's place. The first table row says what 0108 on staging follows |

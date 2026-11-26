# 0037. The Workers staging is the only deployed test environment; Cloud Run staging is retired

Status: Proposed (2026-11-27). Decision 1 restates the owner's direction of 2026-11-27, which is in force from that date whatever the answers below. The rest of this record is the architect's plan for carrying it out, and it waits for the owner's answers under "Decisions requested from the owner". Documentation only: no migration, table, view, function, policy, grant, role, permission or API change.
Date: 2026-11-27
Deciders: owner
Architect: Opus 5.5, standing in for Fable 5.2, which is at its usage limit until 2026-12-01

This record changes, going forward, the staging rules of the accepted records listed in section 2. Those records are not rewritten and stay Accepted (ADR 0001). Their history, such as "ran against Cloud Run revision ...", stands as written.

## Context

- **The owner's direction (2026-11-27).** "Going forward, please skip Cloud Run completely and use Cloudflare staging as our only test environment—just keep our shared 100,000/day Cloudflare request limit in mind for test runs." And: "Please also check if any automated or nightly jobs hit the Cloud Run URL so they don't fail unnecessarily."
- **What Cloud Run staging was.** A trial set up on 2026-09-26 as a second staging deployment against the staging database. It existed because the Workers free plan caps each request at 10 ms of CPU, so server-rendered pages fail at random with error 1102 (`docs/CLOUD_RUN_STAGING.md:8-9`; `docs/ARCHITECTURE.md` §9). The owner deployed it by hand from a launcher outside this repository. CI never deployed it, and the e2e secret and the crons were never pointed at it (`docs/CLOUD_RUN_STAGING.md:235-237`; ADR 0007, note on decision 2: "the Cloud Run continuous deploy of this answer was never set up").
- **Its state now.** The Cloud Run staging trial is stopped and will not be used again. It cannot be deployed, and nothing can be checked on it.
- **What already does the heavy work.** In-runner builds. The lifecycle nightly builds the commit and starts it on `http://localhost:3100` against the staging database (`.github/workflows/lifecycle-nightly.yml:27-34`; ADR 0007 decision 2, note of 2026-10-18). The pull-request e2e job does the same (`.github/workflows/pr-checks.yml:78-91`; owner decision of 2026-10-20). `scripts/lifecycle-nightly.sh` gives each run its own fresh cron and impersonation secrets (`:166-187`) and can be run by hand on the developer machine (`:9-12`).
- **What still names Cloud Run.** The accepted records of section 2, the hand-run tools and specs of section 4, and the living documents of section 6.
- **The shared request budget.** The Workers staging (`my-lms`) and production (`my-lms-prod`) are on one Cloudflare account on the free plan (`docs/ARCHITECTURE.md` §1, App row; ADR 0015, readings note of 2026-11-05, item 13). They share the account's daily request limit, 100,000 by the owner's figure. Production has no learner yet. The pilot release (ADR 0033) brings the first.
- **Why a record.** The direction changes rules in accepted records. It is the owner's own direction, so it is recorded here at named points, not reported back as a conflict. ADR 0033 did the same for ADR 0024.

## Decision

**Goal.** One deployed staging site, the Workers staging. Every check that needs more than its free plan gives runs on an in-runner build. Test runs keep production's share of the daily request limit safe.

**Out of scope.** Production: its Worker, its deploys, its crons and its data. Any credential change. Workers Paid. Any new host or provider. The detail of the code follow-ups (F1 to F3), each of which gets its own small plan and review.

### 1. The decision

- The Workers staging (`my-lms`, deployed by `.github/workflows/deploy-staging.yml` on every push to `main`) is the only deployed test environment.
- Cloud Run staging is retired. Nothing is deployed there. Nothing waits for it. No check runs there. No secret is set or rotated for it.
- Two targets replace it. Which one applies depends on what the rule needed:
  - **(W) the Workers staging.** For a rule that needs the deployed staging site: "both staging deployments", "the owner's Cloud Run deploy", "code first on every deployment that shares the database", or a page check after a merge. It now waits only for the green Workers staging deploy of that commit.
  - **(R) an in-runner build.** For a rule that used Cloud Run because the Worker's free plan cannot finish the work: a Guardian run, the completion sweep POSTs, a large CSV, a lifecycle spec that launches real packages, or any repeated run. The build is `scripts/lifecycle-nightly.sh` (with `LIFECYCLE_SPECS`) or `scripts/e2e-in-runner.sh`, in the GitHub runner or on the developer machine, against the staging database. Never the Worker.
- A lifecycle spec run by hand uses (R) by default. It uses (W) only when its own record asks for the deployed site and it fits the free plan and section 5.

### 2. What this changes in accepted records

Line numbers are those on `main` at fbea6d9 and only help today's reader. Rows marked "done" were met before this date. They bind only a repeat.

| Record | Where | It says | From 2026-11-27 |
|---|---|---|---|
| ADR 0005 | Note item (g), the Workers measurement (L8, the owner's D14) (`0005:164`) | The first 2.0 uploads go through Cloud Run staging only | (R): through an in-runner or local build on the staging database. The one measured Guardian run on the Workers staging stays as written |
| ADR 0005, ADR 0006 | Note (h) and its addition of 2026-10-19 (`0005:117`, `:138`); ADR 0006 (`0006:106`) | `ALDS_P4` is on for Cloud Run through a deploy with `ALDS_P4=on` | No Cloud Run setting exists any more. The Worker's top-level `[vars]` and the two in-runner scripts carry the flag |
| ADR 0007 | Decision 2 (`0007:75-77`) | The Cloud Run continuous deploy is "an owner action still to be done" | It will not be done. The in-runner target of the note of 2026-10-18 stands alone |
| ADR 0007 | Step 16 (`0007:42`) | Cloud Run staging needs an owner deploy before the step-0 specs run there | Void |
| ADR 0009 | Step 9 and the Status line (`0009:3`, `:49`) | Code on both the Workers staging and the Cloud Run trial before 0099 | (W). Done 2026-10-18 |
| ADR 0013, ADR 0018 | Alternatives, the Next 16.x upgrade (`0013:31`, `0018:73`) | The OpenNext and Cloud Run builds need checking | The OpenNext build only |
| ADR 0014 | Step 17 (`0014:209`) | Lifecycle on staging on Cloud Run, user-run deploy | (R) by default |
| ADR 0015 | Step 9 (`0015:97`); readings note of 2026-11-04, item 28 (`0015:224`) | The staging proof on Cloud Run; the sweep POSTs carry Cloud Run's secret, read from `KIVO_CLOUD_RUN_CRON_SECRET` | (R), with the run's own secret, `LIFECYCLE_CRON_SECRET`. A Workers host is still refused (section 4; F1) |
| ADR 0017 | Steps 21 and 23 (`0017:159`, `:176`) | After the owner's Cloud Run deploy; lifecycle on Cloud Run | (W) for the deploy order; (R) for the spec |
| ADR 0019 | Step 14 (`0019:147`) | The owner runs the Cloud Run staging deploy, then the specs run on staging | (W) for the deploy; (R) for the specs; the owner's own checks on the Workers staging |
| ADR 0020 | Step 9 (`0020:86`) | Both staging deployments, Cloud Run by the owner's deploy | (W). Staging part done 2026-11-11. Production unchanged |
| ADR 0021 | Budget item 5 and the risks row on a large export (`0021:102`, `:160`) | Cloud Run is the deterministic target | (R) is the deterministic check. On the Worker a large CSV can still fail |
| ADR 0021 | H.2 (`0021:139`) | Deploys to the Workers staging and, by the owner's deploy, to Cloud Run | (W). Done 2026-11-11 |
| ADR 0022 | Item 8, the registrar (`0022:50`) | Cloud Run is the owner's deploy | (W) only |
| ADR 0022 | Item 18, G 18 (`0022:146`) | Spec 66 by hand on Cloud Run staging first | (R). Spec 66 already runs in the nightly, in the runner, and refuses a Workers host (`66-alds-guardian-fixture.spec.ts:310-311`) |
| ADR 0022 | Item 20 (L8, H 20) and D14 (`0022:87`, `:137`) | The first 2.0 uploads go through Cloud Run; D14 is "Workers Paid, or Cloud Run only" | (R) for the first uploads. D14 loses its second option (section 2a) |
| ADR 0024 | Step 20 (`0024:333`) | Phase 2 runs on both staging deployments before 0108 | (W). Done 2026-11-26 |
| ADR 0024 | Step 73 (`0024:736`) | Pull request 1 deploys to both staging deployments | (W) |
| ADR 0024 | The note that defines `SCORM_LATCH_FROM` (F1) (`0024:1927`) | The time at which the last of the two staging deployments stops serving the old commit route | The time at which the Workers staging deploy of that merge goes green |
| ADR 0024 | The phase 2 slice rule and gate list (`0024:2079`, `:2172`) | "the owner deploys Cloud Run"; "serve on both staging deployments" | (W) |
| ADR 0024 | S6, spec 78 (`0024:2418`) | In-runner or Cloud Run | (R) only. Its wall-time risk (`0024:2429`) is an open point (section 2a) |
| ADR 0033 | Part 2, step 4 and risk 16 (`0033:95`, `:195-197`, `:293`) | The Cloud Run deploy script sets both switches for staging; the step-4 unit test reads the script | Not built. The switches go in the Worker's top-level `[vars]`, the two in-runner scripts and `scripts/run-unit-tests.mjs`. The step-4 test reads those, not the script. `docs/CLOUD_RUN_STAGING.md` is not edited for it. Risk 16's protection is that test on `wrangler.toml` |
| ADR 0034 | Step 8 and the Consequences (`0034:153`, `:195`) | The staging check on the Workers staging and on Cloud Run after the owner's next deploy | (W) only. The container-host case of its unit test stays, because it tests the middleware behind any proxy |

ADR 0002 (owner events), ADR 0008, ADR 0019's and ADR 0021's staging-proof notes, and ADR 0025's list of builds name Cloud Run as history or context only. No rule in them changes. ADR 0023 is superseded and is not read.

#### 2a. Three real changes, not remaps

- **ADR 0022, D14.** "Workers Paid, or Cloud Run only": the Cloud Run option no longer exists. D14 is still asked at its point (after L8, before 2.0 reaches production), with the options open then. Nothing is decided here.
- **The first certified 2.0 row on staging.** A Guardian run cannot finish on the Worker's free plan (ADR 0022 item 20). So the first real 2.0 upload, and with it the first certified row that the P4 exit asks for (`docs/ARCHITECTURE.md` §6, P4 row), comes only from an upload through an in-runner or local build on the staging database, never from a deployed staging site. The row lands in the staging database either way. What changes is where the upload is made: the lead starts a local build on the developer machine, and the upload goes through it.
- **ADR 0024 S6, the wall-time risk.** It says the two refresh routes can take about 25 s and 45 s, and that "Cloud Run's request limit and the Workers free plan's behaviour on a request that waits this long are not verified; S6's part B on Cloud Run and the first staging run read them" (`0024:2429`). Staging has no scheduled cron, and an in-runner part B shows only the route on Node. So, unless it was read on Cloud Run before the stop, nothing on staging now shows how the Worker treats such a request. Left alone, the first reading would come from production's scheduled runs. Decision request 5 asks the owner for a staging reading instead.

### 3. Automated jobs: none uses Cloud Run

A search of `.github/` for "Cloud Run", "cloud-run" and "run.app" finds nothing.

| Job | What it calls | Evidence | Fails because Cloud Run stopped? |
|---|---|---|---|
| `lifecycle-nightly.yml`, both jobs | The commit, built and started in the runner on `localhost:3100`, against the staging database | `.github/workflows/lifecycle-nightly.yml:27-34`, `:98-100`, `:139-142`; `scripts/lifecycle-nightly.sh:156-159` | No |
| `pr-checks.yml`, e2e job | The same, through `scripts/e2e-in-runner.sh` | `.github/workflows/pr-checks.yml:78-91`, `:109-116` | No |
| `nightly-e2e.yml` | `E2E_BASE_URL` from the secret `STAGING_NEXT_PUBLIC_SITE_URL` | `.github/workflows/nightly-e2e.yml:52`. That secret is documented as the Workers staging address, and the Worker is built with it (`.github/workflows/deploy-staging.yml:9`, `:38`). It was not repointed when the trial began (`docs/CLOUD_RUN_STAGING.md:235-237`), and later records still name the Workers staging as its target: `.github/workflows/pr-checks.yml:91`; `docs/ARCHITECTURE.md` §1, Tests row, note of 2026-10-20; §8, Core e2e row | No (owner check (a)) |
| `deploy-staging.yml` | Builds and deploys the Workers staging | `.github/workflows/deploy-staging.yml:53-60` | No |
| `cron.yml` | Production only, through `PROD_BASE_URL` | `.github/workflows/cron.yml:12-13`, `:50`, `:72-75` | No |
| `ops-watch.yml` | Production's health route only | `.github/workflows/ops-watch.yml:21`, `:48`, `:120` | No |
| `ops-review.yml` | GitHub issues and runs, and once a day the Workers staging's public health route (`ops/ops-review-prompt.md:24`, loaded at `ops-review.yml:69`; curl allowed at `:86`) | `.github/workflows/ops-review.yml:3-6`, `:86` | No |
| `deploy-prod.yml`, `backup.yml`, `content-backup.yml`, `rls-audit.yml`, `migration-rehearsal.yml` | Production, a database or storage | The search above | No |
| The staging database's pg_cron jobs | Job 1 `refresh-report-views` refreshes the report views inside the database. It is the owner's paste on staging, not a migration in this repository (`docs/ARCHITECTURE.md` §1, Supabase and Crons rows), so its command is not in the repository. The `completion-sweep` job, where it was scheduled, runs the SQL of `supabase/migrations/0112_sweep_time_box.sql:153`. No migration uses `pg_net` | The search of the repository for `net.http_`, `pg_net` and `cron.schedule` | No, as far as the repository shows. Owner check (b) reads the job commands |

**Conclusion.** No workflow calls Cloud Run, so none fails because the service stopped. Nothing in the repository makes a database job call an app address. The pasted job commands are confirmed by owner check (b). What the repository cannot show is listed as read-only owner checks under "Decisions requested from the owner".

### 4. Hand-run tools and specs that name Cloud Run

| Tool or spec | Its Cloud Run part | From 2026-11-27 |
|---|---|---|
| `scripts/staging-cron-post.mjs` | It accepts the Cloud Run host as well as the Workers staging (`:13-16`, `:39`, `:59`) | The Workers staging only, which it already accepts. Each call is one request. F2 removes the Cloud Run host and flips the matching row of its address test (`scripts/check-auth-setup-link-proofs.mjs:1500-1509`) |
| Specs 56 and 57 | The ADR 0015 sweep POSTs run "on Cloud Run only", with `KIVO_CLOUD_RUN_CRON_SECRET`; a Workers host is refused (`56-kivo-release-a-cmi5.spec.ts:17-20`, `:2152-2166`; `57-kivo-release-a-xapi.spec.ts:27-30`, `:631-647`) | **Decided: (R).** `LIFECYCLE_SPECS=56` or `57` with `bash scripts/lifecycle-nightly.sh` on the developer machine, because the kit those specs need is outside this repository. The specs read `LIFECYCLE_CRON_SECRET`, which that script sets for the app it starts. The Workers host stays refused. F1 |
| `tests/bot/env.bot.example:22-24` | Names `KIVO_CLOUD_RUN_CRON_SECRET` | Names `LIFECYCLE_CRON_SECRET`. F1 |
| Spec 66 | "Cloud Run staging or an in-runner build" (`:23-25`, `:94`, `:173`, `:176`, `:310-311`) | The in-runner build, as the nightly already runs it. The messages change. F1 |
| Specs 78 and 79 | `LIFECYCLE_CRON_SECRET`, else `KIVO_CLOUD_RUN_CRON_SECRET` (`78-sweep-time-box.spec.ts:64-67`, `:75-79`, `:101`, `:242-243`; `79-email-separation.spec.ts:45-48`, `:64`, `:449`) | `LIFECYCLE_CRON_SECRET` only. F1 |
| Specs 48 and 63 | Comments on timings measured on Cloud Run (`48-abandoned-terminal.spec.ts:101`; `63-continue-next-step.spec.ts:109`, `:553`) | No change needed |
| `scripts/cloud-run-deploy.sh`, `cloudbuild.yaml`, `Dockerfile`, `.dockerignore` | The container build and deploy of the trial (`docs/CLOUD_RUN_STAGING.md:13-16`) | Nobody runs them. `tests/unit/no-email-fallback.test.ts:60` reads the deploy script, so it is removed together with that test's change. F3 |
| App code comments | `lib/http/after-response.ts`, `lib/auth/safe-next.ts`, `app/auth/callback/route.ts`, `app/api/integrations/enter/route.ts`, `app/api/integrations/exit/route.ts`, `lib/alds/flag.ts`, `next.config.ts` | The handling of a request behind a proxy stays. It protects any proxy host, and `tests/unit/sign-in-next.test.ts:92-167` and `tests/unit/privacy-notice.test.ts` keep their container-host cases. Comment edits are optional. F3 |
| `docs/CLOUD_RUN_STAGING.md` | The trial's runbook | A retired banner. The rest is kept as history (section 6) |

Why (R) for specs 56 and 57, and not the Worker:
- the specs' own reason: the free plan could cut a run between a latch and its message (`56-kivo-release-a-cmi5.spec.ts:2153-2154`);
- a kit run launches real packages, and every package file a browser fetches is a request to the Worker through the content route (`docs/ARCHITECTURE.md` §1, Learning-data flow, step 1);
- the unscored variant waits a real 15 minutes for the sweep.

With (R) the loopback receiver also works, which ADR 0015 step 9 found unreachable from Cloud Run, so the payload can later be asserted end to end. That is optional and is not part of F1.

### 5. The daily request budget

**The figures that can be counted.**
- Production's own schedule makes at most about 655 requests a day. From `cron.yml:22-31`: 288 `lrs-forward`, 96 `gamification-refresh`, 96 `report-card-refresh`, 24 `journey-nudges` and 4 daily jobs, plus a weekly and a monthly one. From `ops-watch.yml:28-29`: 144 probes and one digest. GitHub often starts fewer.
- Production's learners come with the pilot. Every package file a learner's browser fetches is one request to the Worker, so each course launch costs many requests. The figure per launch has not been measured.
- On staging, `nightly-e2e` and the daily ops review's single health probe (`ops/ops-review-prompt.md:24`) are the only automated jobs that call the Worker. `nightly-e2e` runs once a night across five browser projects (`nightly-e2e.yml:31`, `:56-58`, `:69`). Its figure has not been measured (F5).
- The pull-request e2e job and the lifecycle nightly cost the Worker nothing. Both run in the runner.
- `tests/load` ramps to 300 virtual users (`tests/load/learner-journey.js:66-72`), and its README points at staging (`tests/load/README.md:4`). One run can use the whole day.
- Whether files served from `[assets]` (`wrangler.toml:34-36`) count toward the limit is Cloudflare's rule. It is read when the count is first recorded (owner check (d)).

**The rule.** The owner answers the figures in decision request 2.
1. **No load test against either Worker** while the account is on the free plan. A load test runs only against a local `next start` build, and its figures say nothing about the Workers.
2. **Heavy or repeated runs go in-runner (R).** That means lifecycle specs by default, re-runs until green, loops, bisects, and any spec that launches packages more than a few times. Nothing runs against the Worker with `--repeat-each` or in a loop.
3. **On the Workers staging:** `nightly-e2e` (one run a night), page checks after a staging deploy, and a single hand run of a named spec or harness when its record asks for the deployed site.
4. **Each hand run on the Worker states its request count** in its pull request or dated note. The figure comes from a measured earlier run: the staging Worker's count read before and after, with nothing else running.
5. **Ceilings.** Staging's own share of a day stays under 20,000 requests. A hand run expected to send more than 5,000 goes in-runner. No hand run starts on the Worker while the account's count for the day reads above 50,000. If `nightly-e2e` measures above 10,000 a night, the owner is asked whether to cut its browser matrix or move it in-runner.
6. **If the limit is reached,** Cloudflare refuses further requests to both Workers until its daily count resets. That stops production's learners, its crons (`cron.yml` goes red) and its health probe (`ops-watch.yml` opens an incident). The rule exists so that a staging run never does this.

**How to read the day's count.** In the Cloudflare dashboard, under Workers & Pages:
- the account's request usage for the day, against the daily limit;
- each Worker's own metrics (`my-lms` for staging, `my-lms-prod` for production), for its share.

The owner confirms, on first use, where the figure sits and when the day rolls over. The lead records both as a dated note under this record (owner check (d)).

### 6. Living documents updated with this record

These edits are applied with this record, on the owner's direction of 2026-11-27, while the record itself stays Proposed. Where a correction points at a rule of this record that waits for the owner, it says "proposed". Each anchor is one physical line, or a part of one, found exactly once in its file at fbea6d9. The files keep their own line endings.

Not edited:
- any accepted ADR body, `docs/release/*` and migration headers;
- `docs/MIGRATIONS.md:92-93`, which is history;
- `docs/ambak-learning-data-standard/BLUEPRINT.md:816`, `:1016` and `:1075`, which name Cloud Run for hand-run cron calls and the step-0 gate. The section map of `docs/ARCHITECTURE.md` §5 governs where the two differ. E7 corrects the §0 row, and the two P5 lines are read as target (R) when P5 is planned.

`docs/CI-CD.md` names no Cloud Run step.

**E1. `docs/ARCHITECTURE.md`, header paragraph.**
Anchor:
```
corrected early here as a dated correction). It says what the system is
```
Replacement:
```
corrected early here as a dated correction). Updated 2026-11-27 for ADR 0037 (proposed; the owner's direction of that date: the Cloud Run staging trial is stopped and will not be used again, and the Workers staging is the only deployed test environment), each as a dated correction: §1 (the App, Crons and Tests rows), §2 (`scripts/`), §3 (principle 4), §5 (the §0 row and the Cloud Run staging row), §7 (ADR 0007 decision 2), §8 (ADR 0022 G 18) and §9 (the free-plan hazard). It says what the system is
```

**E2. `docs/ARCHITECTURE.md` §1, Environments, App row, staging cell.**
Anchor:
```
none has been uploaded on staging (spec 66 is to produce the first Guardian rows) |
```
Replacement:
```
none has been uploaded on staging (spec 66 is to produce the first Guardian rows). Correction 2026-11-27 (the owner's direction of that date; ADR 0037, proposed): the Cloud Run staging trial is stopped and will not be used again. The Workers staging `my-lms` is the only deployed staging environment. A rule that says "both staging deployments" or waits for "the owner's Cloud Run deploy" now waits only for the green Workers staging deploy of that commit (`deploy-staging.yml`); ADR 0037 section 2 proposes an in-runner build for the checks the Worker cannot finish. The Workers staging shares the account's daily request limit with production; ADR 0037 section 5 proposes a rule for test runs |
```

**E3. `docs/ARCHITECTURE.md` §1, Environments, Crons row, staging cell.**
Anchor:
```
first scheduled run 2026-11-11, 03:30:00.44 to 03:30:00.99 UTC, green (the Supabase row above) |
```
Replacement:
```
first scheduled run 2026-11-11, 03:30:00.44 to 03:30:00.99 UTC, green (the Supabase row above). Note 2026-11-27 (ADR 0037): no workflow calls Cloud Run, and no migration in this repository makes a database job call an app address (no `pg_net`); the commands of the staging pg_cron jobs, which are owner pastes, are read once in ADR 0037's owner check (b) |
```

**E4. `docs/ARCHITECTURE.md` §1, Environments, Tests row, staging cell.**
Anchor:
```
no scheduled job that builds or tests the app runs with the flag absent | never |
```
Replacement:
```
no scheduled job that builds or tests the app runs with the flag absent. Correction 2026-11-27 (ADR 0037): no workflow ever targeted Cloud Run, so none fails because it stopped. Deployed-site checks are made on the Workers staging only. Proposed in ADR 0037 and awaiting the owner: checks its free plan cannot finish (a Guardian run, the completion sweep POSTs, a large CSV) run on an in-runner build, and no load test runs against either Worker (its section 5) | never |
```

**E5. `docs/ARCHITECTURE.md` §2, `scripts/` row.**
Anchor:
```
run by `e2e-in-runner.sh` after its build |
```
Replacement:
```
run by `e2e-in-runner.sh` after its build. Correction 2026-11-27 (ADR 0037): `cloud-run-deploy.sh` deploys a staging service that is stopped and will not be used again; nobody runs it, and its removal is a follow-up of ADR 0037 |
```

**E6. `docs/ARCHITECTURE.md` §3, principle 4.**
Anchor:
```
A `v*.*.*` tag deploys production; never push one as a bookmark.
```
Replacement:
```
A `v*.*.*` tag deploys production; never push one as a bookmark. Correction 2026-11-27 (ADR 0037): there are no Cloud Run deploys any more; the Cloud Run staging trial is stopped.
```

**E7. `docs/ARCHITECTURE.md` §5, blueprint table, §0 row.**
Anchor:
```
waits for the owner's Cloud Run deploy. The P2/P3 KIVO patch becomes part of engine release A (ADR 0006). Reaches production with v1.3.0 (ADR 0007). |
```
Replacement:
```
waits for the owner's Cloud Run deploy. The P2/P3 KIVO patch becomes part of engine release A (ADR 0006). Reaches production with v1.3.0 (ADR 0007). Correction 2026-11-27 (ADR 0037): Cloud Run staging is retired; a staging gate written for it is read on the Workers staging, or, as ADR 0037 section 2 proposes, on an in-runner build for a check the Worker's free plan cannot finish |
```

**E8. `docs/ARCHITECTURE.md` §5, governing documents, Cloud Run staging row.**
Anchor:
```
| Cloud Run staging | `docs/CLOUD_RUN_STAGING.md` | ADR 0007 |
```
Replacement:
```
| Cloud Run staging | `docs/CLOUD_RUN_STAGING.md` | ADR 0007. Correction 2026-11-27: retired by ADR 0037; the document is kept as history only |
```

**E9. `docs/ARCHITECTURE.md` §7, row ADR 0007, decision 2.**
Anchor:
```
| Decided; the Cloud Run continuous deploy is an owner action still to be done |
```
Replacement:
```
| Decided; the Cloud Run continuous deploy is an owner action still to be done. Correction 2026-11-27 (ADR 0037): it will not be done; the Cloud Run staging trial is stopped, and the in-runner target of ADR 0007 decision 2's note of 2026-10-18 stands alone |
```

**E10. `docs/ARCHITECTURE.md` §8, row ADR 0022 G 18.**
Anchor:
```
| lifecycle by hand on Cloud Run staging first, then `lifecycle-nightly` (`DEFAULT_SPECS` gains 66) |
```
Replacement:
```
| lifecycle by hand on Cloud Run staging first, then `lifecycle-nightly` (`DEFAULT_SPECS` gains 66). Correction 2026-11-27 (ADR 0037): in `DEFAULT_SPECS` since pull request 240; a hand run uses an in-runner build (`scripts/lifecycle-nightly.sh`), never the Workers staging |
```

**E11. `docs/ARCHITECTURE.md` §9, the free-plan hazard.**
Anchor:
```
Cloud Run is the deterministic staging target but needs an owner deploy.
```
Replacement:
```
Cloud Run is the deterministic staging target but needs an owner deploy. Correction 2026-11-27 (ADR 0037): Cloud Run staging is stopped and will not be used again. ADR 0037 (proposed) makes an in-runner build against the staging database (`scripts/lifecycle-nightly.sh`, `scripts/e2e-in-runner.sh`) the deterministic target; it runs Next on Node and so does not prove the Workers build. The Workers staging and production share the account's daily request limit, and a day that reaches it stops production too; ADR 0037 section 5 proposes a rule for test runs.
```

**E12. `docs/CLOUD_RUN_STAGING.md`, a retired banner under the title, before the first paragraph.**
Anchor:
```
**Decisions (2026-09-26):** dedicated Google Cloud project, **staging**
```
Replacement:
```
> **Retired 2026-11-27 (ADR 0037).** The Cloud Run staging trial is stopped and
> will not be used again. The Workers staging is the only deployed staging
> environment; a check its free plan cannot finish runs on an in-runner build
> (`scripts/lifecycle-nightly.sh`, `scripts/e2e-in-runner.sh`). Do not run
> `scripts/cloud-run-deploy.sh`, and do not create or rotate secrets for this
> service. The rest of this page is kept as history only.

**Decisions (2026-09-26):** dedicated Google Cloud project, **staging**
```

**E13. `docs/MIGRATIONS.md`, "Every migration", a forward note after the deploy-safe bullet.**
Anchor:
```
writes it must only do so when a value is supplied.
```
Replacement:
```
writes it must only do so when a value is supplied.
- Staging has one deployment, the Workers staging (ADR 0037, 2026-11-27).
  Where a file header, an ADR or this page says "code first on both staging
  deployments" or "on every deployment that shares the database", on
  staging that is the green Workers staging deploy of the code from `main`
  (`deploy-staging.yml`). Cloud Run staging is stopped and is never waited
  for. Production is unchanged.
```

**E14. `ops/RUNBOOK.md` §6.3, setup step 2.**
Anchor:
```
comments in `wrangler.toml`). Cloud Run: `docs/CLOUD_RUN_STAGING.md` §2.
```
Replacement:
```
comments in `wrangler.toml`). Cloud Run staging is retired (ADR 0037).
```

**E15. `ops/RUNBOOK.md` §6.3, "The allow-list", staging's value (first line).**
Anchor:
```
Staging's value, the same for the staging Worker and Cloud Run staging. The
```
Replacement:
```
Staging's value, set on the staging Worker only (ADR 0037). The
```

**E16. `ops/RUNBOOK.md` §6.3, staging's value (second line).**
Anchor:
```
real addresses are typed only into the two secrets, never into a file, a page,
```
Replacement:
```
real addresses are typed only into its secret, never into a file, a page,
```

**E17. `ops/RUNBOOK.md` §6.3, "Setting it" (first of four lines).**
Anchor:
```
takes effect immediately; on Cloud Run staging,
```
Replacement:
```
takes effect immediately. Cloud Run staging
```

**E18. `ops/RUNBOOK.md` §6.3, "Setting it" (second of four lines).**
Anchor:
```
add a version to the secret `lms-platform-email-allow-domains`, and each
```
Replacement:
```
is retired (ADR 0037): no secret is added there, and the staging
```

**E19. `ops/RUNBOOK.md` §6.3, "Setting it" (third of four lines).**
Anchor:
```
instance started after that, like the next deploy, picks it up (the deploy
```
Replacement:
```
Worker is the only staging deployment that reads this list.
```

**E20. `ops/RUNBOOK.md` §6.3, "Setting it" (fourth of four lines; the rest of that line is kept).**
Anchor:
```
script mounts the newest version). Then "Send test".
```
Replacement:
```
Then "Send test".
```

**E21. `ops/RUNBOOK.md` §6.3, "Rotation".**
Anchor:
```
put`; Cloud Run: a new secret version and a redeploy), then "Send test".
```
Replacement:
```
put`), then "Send test".
```

**E22. `docs/ops/supabase-auth-smtp.md`, "Add Redirect URL allow-list entries" (first of two lines).**
Anchor:
```
lets `next dev` work locally. Add the Cloud Run staging address
```
Replacement:
```
lets `next dev` work locally. Add any custom domain the same way. Save. Cloud
```

**E23. `docs/ops/supabase-auth-smtp.md`, the same paragraph (second of two lines).**
Anchor:
```
(`docs/CLOUD_RUN_STAGING.md` §4) and any custom domain the same way. Save.
```
Replacement:
```
Run staging is retired (ADR 0037); its lines, if still listed, may be removed.
```

## Database changes

None. No migration, table, view, function, policy or grant. Owner check (b) is one read-only select.

## Steps for the executor (follow-ups)

No step starts before the owner accepts this record. Each is its own small pull request with one independent review. F1 and F2 may share one.

1. **F1. The specs' cron secret (test-only).**
   - Files: specs 56, 57, 66, 78 and 79; `tests/bot/env.bot.example`.
   - Specs 56 and 57 read `LIFECYCLE_CRON_SECRET`. Their `.workers.dev` refusal stays, and its message says "an in-runner or local build".
   - Specs 78 and 79 drop the `KIVO_CLOUD_RUN_CRON_SECRET` fallback.
   - Spec 66's messages name the in-runner build only.
   - Verified by `npm run test:unit`, typecheck and lint; spec 78 by `LIFECYCLE_SPECS=78 bash scripts/lifecycle-nightly.sh` against staging (in the runner, no Worker request); specs 56 and 57 at their next kit run.
2. **F2. `scripts/staging-cron-post.mjs`.**
   - Remove the Cloud Run host (`:13-16`, `:39`, `:59`).
   - In `scripts/check-auth-setup-link-proofs.mjs:1500-1509` the Cloud Run row expects `false`, and the line it prints counts one staging app.
   - If decision request 5 is yes, the route list (`:36`) gains `gamification-refresh` and `refresh-report-views`, each used with `--once`.
   - Verified by running that proof script's address test and the unit job.
3. **F3. Container files.**
   - Remove `scripts/cloud-run-deploy.sh` and `cloudbuild.yaml`, and the script's entry in `tests/unit/no-email-fallback.test.ts:60`.
   - Keep `Dockerfile`, `.dockerignore` and the `NEXT_OUTPUT=standalone` switch in `next.config.ts`. They cost nothing and are not tied to one host.
   - Optional comment edits in the app files of section 4. No behaviour change.
   - Verified by the unit job, typecheck, lint, and the pull-request e2e build.
4. **F4. Pointer notes (architect, after acceptance).** One dated line under each accepted record named in section 2: "Note 2026-11-27: Cloud Run staging is retired; this record's Cloud Run rule reads as ADR 0037 section 2 says." It is a note, not an edit.
5. **F5. Measure `nightly-e2e`.** The owner reads the staging Worker's request count for one day that holds a `nightly-e2e` run (owner check (d)). The lead records it here as a dated note and applies rule 5 of section 5.
6. **F6. ADR 0033 step 4, when built.** The switch test reads `wrangler.toml`, `scripts/e2e-in-runner.sh`, `scripts/lifecycle-nightly.sh` and `scripts/run-unit-tests.mjs`, not `scripts/cloud-run-deploy.sh` (section 2).

## Verification

- After the edits of section 6, no line in `docs/ARCHITECTURE.md`, `ops/RUNBOOK.md` or `docs/ops/supabase-auth-smtp.md` directs a future staging step to Cloud Run. Lines that name it as history stay.
- The first `nightly-e2e` and `lifecycle-nightly` runs after 2026-11-27 are read by the lead with `gh run list`. A red run is checked for any Cloud Run cause, and section 3 expects none.
- Owner checks (a) to (d) are recorded as dated notes under this record.
- Each follow-up carries the verification named in its step.

## Risks and protections

| # | Risk | Protection |
|---|---|---|
| 1 | A staging run uses up the account's day and stops production (learners, crons, health) until the count resets | Section 5: no load test on any Worker; heavy and repeated runs in-runner; the staging share and per-run ceilings; the day's count read before a hand run; `nightly-e2e` measured (F5) |
| 2 | A check the free plan cannot finish runs on the Worker and fails at random (error 1102), or a Guardian run stays pending | (R) for those checks. Specs 56, 57, 66 and 78 refuse a `.workers.dev` host before writing. A page check that fails with 1102 is reloaded once, never looped |
| 3 | The in-runner build is Next on Node, not the OpenNext Workers build, so a fault in the adapter shows only on a Worker | `nightly-e2e` on the Workers staging every night; page checks after each staging deploy (W) |
| 4 | Time bounds set on Cloud Run fail in-runner. From the runner each database call costs about 260 ms (ADR 0019, note at `0019:298`) | A bound is measured again in-runner and set from that run, never past the product's own bound, as spec 63's were. A red bound is a spec fix, not a product change |
| 5 | The stopped service is resumed and serves its last revision against a staging database that has moved on (0107, 0108 and later) | Decision request 3: the trial project is shut down. Until then nothing points at it: no CI, no cron and, after section 6, no document |
| 6 | The trial project still holds copies of staging secrets: the service-role key, the cron and impersonation secrets (`docs/CLOUD_RUN_STAGING.md:88-90`) and staging's platform mail settings (`:121-130`) | Decision request 3 removes them with the project. No credential change is proposed here. A rotation stays the owner's own decision |
| 7 | An executor reads an accepted record's Cloud Run rule as still binding and waits for a deploy that never comes | Section 2's table, the corrections of section 6, and the pointer notes of F4 |
| 8 | A tool sends a cron secret to the old host | `staging-cron-post.mjs` posts only to the address it is given, and F2 removes the old host from its allow-list. F1 removes the Cloud Run secret from the specs |
| 9 | Learners | None on staging, and none yet on production. No learner-facing code changes |
| 10 | Grading | No scoring, attempt or completion rule changes. The specs that prove grading run on the same code, in-runner |
| 11 | Privacy | No data moves. The copies of staging secrets in the trial project go with decision request 3 |
| 12 | Existing records | No migration, no write, no delete. Staging and production rows are untouched |

## Consequences

- One deployed staging site. No owner deploy step stands between a merge and a staging check any more.
- Deployed-site checks run under the free plan's CPU cap, so error 1102 stays possible there. Heavy checks run only in-runner.
- Test runs on the Worker spend the budget production depends on. Load tests leave the Workers.
- ADR 0022's D14 loses an option. The first certified 2.0 row on staging comes from a local build.
- Five specs, one script and one unit test need small changes (F1 to F3).
- `docs/CLOUD_RUN_STAGING.md` becomes history.

## Alternatives considered

1. **Keep Cloud Run staging and resume the trial.** Not chosen: the owner's direction.
2. **Workers Paid for the account.** It would lift the CPU cap and the request limit for both Workers. Not chosen now: the account stays on the free plan by the owner's choice. ADR 0022's D14 can bring it back.
3. **Another container host for staging.** Rejected. It means a new provider, new secrets and a new deploy path, for what the in-runner build already gives.
4. **Move `nightly-e2e` in-runner too.** Rejected for now. It is the only nightly check of the Workers build. It comes back to the owner if its measured count is too high (section 5, rule 5).
5. **A separate Cloudflare account for staging, with its own daily limit.** Not proposed. It moves staging's deploy token, its Worker address and its sign-in settings. The rule of section 5 is enough while staging's traffic is small. The owner may ask for it.

## Decisions requested from the owner

| # | Question | Recommended | Cost of the recommended answer |
|---|---|---|---|
| 1 | Accept this record: the Workers staging as the only deployed test environment, the two targets of section 1, the three changes of section 2a, and the follow-ups F1 to F6 | Yes | Three small pull requests, each with one review |
| 2 | The budget figures of section 5, rule 5: staging under 20,000 requests a day; a hand run expected above 5,000 goes in-runner; no hand run on the Worker while the account's day reads above 50,000; ask the owner if `nightly-e2e` measures above 10,000 a night | Yes | Some hand runs wait a day or move in-runner |
| 3 | Shut down the stopped trial project in its provider's console, so that the stopped service can never be resumed against the staging database and no copy of staging's secrets stays there. The owner does it | Yes | None. No data and no code lives only there |
| 4 | The Cloud Run addresses in the staging project's sign-in redirect list (`docs/CLOUD_RUN_STAGING.md` §4) | Remove when convenient, and before the first learner at the latest. Harmless meanwhile, since nothing serves those addresses | One owner edit in the dashboard |
| 5 | How the Worker's handling of a long cron request (ADR 0024 S6's wall-time risk, section 2a) is read, now that Cloud Run is gone | One hand POST of each of the two refresh routes on the Workers staging, with staging's cron secret, read once and recorded here; F2 adds the two routes to `scripts/staging-cron-post.mjs` | Two requests and two lines of script. Without it, the first reading comes from production's scheduled runs |

Owner checks, read-only, each recorded as a dated note:
- (a) The secret `STAGING_NEXT_PUBLIC_SITE_URL` holds the Workers staging address. A repository secret cannot be read back. A green `nightly-e2e` run after the stop confirms it, or the owner sets the secret again to the Worker's address.
- (b) On staging, in the SQL editor: `select jobname, schedule, command from cron.job;`. Every command is SQL, with no `net.` call.
- (c) Any outside uptime monitor (`nightly-e2e.yml:13` names one) that watches a Cloud Run address is removed.
- (d) Where the Cloudflare dashboard shows the account's requests for the day, and when the day rolls over; then the `nightly-e2e` figure of F5.

### Owner answers

One line per question. Nothing is built for a question before its line is filled.

- 1, accept this record (yes or no):
- 2, the budget figures (yes, or other figures):
- 3, shut down the trial project (yes or no):
- 4, the redirect addresses (remove when convenient, or leave):
- 5, the long-request reading (a staging hand POST, or production's runs):

## References

- ADR 0001 (records are not rewritten). The accepted records of section 2.
- `docs/ARCHITECTURE.md` §1 (Environments; Learning-data flow), §3, §5, §7, §8 and §9.
- `docs/CLOUD_RUN_STAGING.md`; `docs/MIGRATIONS.md`; `ops/RUNBOOK.md` §6.3; `docs/ops/supabase-auth-smtp.md`.
- `.github/workflows/`: `lifecycle-nightly.yml`, `pr-checks.yml`, `nightly-e2e.yml`, `deploy-staging.yml`, `cron.yml`, `ops-watch.yml`, `ops-review.yml`.
- `scripts/lifecycle-nightly.sh`; `scripts/e2e-in-runner.sh`; `scripts/staging-cron-post.mjs`; `scripts/check-auth-setup-link-proofs.mjs`; `scripts/cloud-run-deploy.sh`; `wrangler.toml`; `tests/load/`.
- Specs 48, 56, 57, 63, 66, 78 and 79 under `tests/bot/lifecycle/`; `tests/bot/env.bot.example`; `tests/unit/no-email-fallback.test.ts`; `tests/unit/sign-in-next.test.ts`; `tests/unit/privacy-notice.test.ts`.

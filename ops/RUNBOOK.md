# LMS Operations Runbook

The operating manual for the **AI LMS Ops Engineer** — the senior-engineer knowledge
this system runs on. Any Claude session (interactive, `/ops-review`, or a scheduled
routine) and any human on-call should follow this document.

---

## 1. Operating model — three layers

| Layer | What | Cadence | Cost of failure |
|---|---|---|---|
| **L1 Deterministic watchdog** | `.github/workflows/ops-watch.yml` probes `GET /api/ops/health` on prod; files/updates its own GitHub issue (`ops-incident`, titled "🔴 Ops incident: prod health <status>") on degraded/down; auto-closes that issue on recovery, and never touches any other `ops-incident` issue; posts a daily digest comment (`ops-digest` issue). | every 10 min, 24/7 | none — it's dumb and reliable |
| **L2 AI review** | `.github/workflows/ops-review.yml` — headless Claude Code in Actions (daily 02:15 UTC, issues-only, subscription token — no metered billing possible) — plus `/ops-review` (skill) for on-demand interactive sessions: reads health + heartbeats + digests + recent workflow runs, triages against this runbook, opens issues; fixes are drafted only in interactive sessions. | daily + on-demand | bounded by §7 safe-actions |
| **L3 Human (you)** | Approves anything in §7's "requires approval" list; receives pages via GitHub notifications on `ops-incident` issues. | on page / daily digest | — |

### Switching the AI engine (L2)

The daily review is engine-pluggable; all engines share one prompt file
(`ops/ops-review-prompt.md` — edit once, applies to all). To switch:

- **Permanently:** GitHub → Settings → Secrets and variables → Actions →
  **Variables** tab → set `OPS_REVIEW_ENGINE`. No code change, no PR.
- **For one run:** Actions → "Ops AI review (daily)" → Run workflow → type the
  engine name.

| Engine | Variable value | Required secret | Cost reality |
|---|---|---|---|
| Claude (default) | `claude` (or unset) | `CLAUDE_CODE_OAUTH_TOKEN` (`claude setup-token`) | Draws on the Pro/Max plan allowance; no payment method attached → metered charges impossible; exhausted allowance = run fails, never bills |
| Gemini | `gemini` | `GEMINI_API_KEY` (AI Studio) | Free tier = 20 req/day — live-tested **insufficient** for one agentic review; usable only with billing enabled on the key's GCP project |
| OpenAI | `openai` | `OPENAI_API_KEY` | Commented template in ops-review.yml — verify the codex CLI invocation, uncomment, and extend the unknown-engine guard before first use |

Safety does not depend on the engine: the job token is `contents: read`
(cannot push) and each engine gets a read-only + gh/curl/jq tool allowlist.

**Design stance:** this stack is **serverless** (Cloudflare Workers + Supabase).
There are no servers to restart, no disks to fill, no OS to patch — CPU/memory/
autoscaling are Cloudflare's and Supabase's job. Our ops surface is: **app
correctness, scheduled jobs, database health/quota, email delivery, learning-
pipeline integrity (SCORM/cmi5/xAPI/LRS), security posture, deploys, cost/capacity.**
That is what we monitor and what this runbook covers.

---

## 2. System map

```
Learner ⇄ Cloudflare Worker (Next.js 15 App Router via @opennextjs/cloudflare)
              │  fetch-only worker: NO scheduled handler → GH Actions drives crons
              ├── Supabase Postgres (+ RLS, tenant isolation)   ──┐
              ├── Supabase Auth (magic link / password / SAML SSO)│ per-env project
              ├── Supabase Storage (packages, public-assets)    ──┘
              ├── Edge Function `send-smtp` (Workers have no TCP → SMTP via Deno fn)
              │     tenant SMTP (learner mail) and the platform's own mailbox (platform mail, ADR 0029)
              │     no fallback: mail that its own sender cannot carry is recorded as not sent
              └── Tenant external LRS (xAPI forwarding: outbox → waitUntil + cron drain)
GitHub Actions: cron.yml (job scheduler) · ops-watch.yml (watchdog) ·
                deploy-staging.yml (push→main) · deploy-prod.yml (tag v*.*.*, manual gate) ·
                rls-audit.yml (PR gate on migrations)
```

### Environments

| | Staging | Production |
|---|---|---|
| Worker | `my-lms.mentora.workers.dev` | `PROD_BASE_URL` repo secret |
| Supabase ref | `zeaclbapadosqqttexxh` | `alkfrcglmseksweqhwzq` |
| Deploy trigger | push to `main` (auto) | tag `v*.*.*` (manual gate) |
| Crons fired by cron.yml | ❌ (prod only) | ✅ |
| `OPS_EXPECT_CRONS` var | unset (0) | **must be `1`** |

**Standing rules:** never write test/seed data to PROD. Migrations are applied
**by hand** (SQL editor) → prod/staging **drift is a known hazard**; write DDL
drift-safe (`if exists`, `to_regclass()` guards) and probe before releases (§6.7).

---

## 3. Signals

| Signal | Where | Semantics |
|---|---|---|
| **Deep health** | `GET /api/ops/health` (`x-cron-secret` header for detail) | `ok` / `warn` (advisory: LRS backlog, email failures, or a job scheduled more than once a day — `lrs-forward`, `gamification-refresh`, `journey-nudges` — stale with its last run less than 26 h ago, which GitHub's cron starvation causes; or the last run of `lrs-forward` (its preview check or its park write failed, §6.5), `reminders` or `journey-nudges` (one of the job's own steps failed, §6.2) ended in an error while its heartbeat is fresh) / `degraded` (storage; a stale daily, weekly or monthly job; a job never seen; a frequent job whose last run is more than 26 h ago) / `down` (DB unreachable, HTTP 503). Heartbeats count on prod only (`OPS_EXPECT_CRONS=1`); ADR 0007, note of 2026-11-14 on decision 4; ADR 0024, note of 2026-11-15 |
| **Platform sender** | `GET /api/ops/health` with the secret: `email_checks.platform_email` (never under `checks`, so the watchdog's summary never prints it); `/super/email` and the console banner | `fail` (not configured; the log unreadable; the newest send an `auth` or `quota` failure; two failed sends in a row; the daily ceiling) makes the authenticated status `degraded`; one `timeout`, `unreachable` or `unknown` send, or half the ceiling, `warn`. The unauthenticated status never includes it. **`degraded` with every printed check `ok` is the platform sender**: read `email_checks` with the secret, then §6.3. ADR 0029 section H |
| **Tenant mail** | `GET /api/ops/health` with the secret: `email_checks.tenant_smtp`, `mail_jobs`, `mail_recipients` and `mail_crons` (never under `checks`); `/super/email` | `tenant_smtp`: the organisations by reading (§6.3b); `warn` while an organisation with members is `failing`, is `not_configured`, or is past the point where its daily limit holds back routine mail. `mail_jobs`: reset-code and sign-in-link jobs the platform ended after their start mark, counted for today and yesterday (UTC); `warn` from 3 lost, or from a lost share over 2% once 50 jobs have started. `mail_recipients`: `warn` for 24 h after a request skipped its mail because its recipients could not be read (§6.2). `mail_crons`: the two reminder jobs' state, last run, last successful run, failure details and pending reminders (§6.2); its status repeats what `crons` reads for them and is no input of the overall status. None of them reads `fail`, and `unknown` moves nothing. Without migration 0114 `tenant_smtp` and `mail_jobs` read `unknown`; `mail_recipients` and `mail_crons` need no migration. The unauthenticated status is computed without them. ADR 0029 section H and its notes of 2026-11-19 and 2026-11-20 |
| **Cron heartbeats** | `ops_heartbeats` table (migration 0050); each cron upserts on every run | staleness vs cadence map in the health route; `last_status` `error` reads `warn` for `lrs-forward`, `reminders` and `journey-nudges` (`ERRORED_WARN`) until that job's next clean run, on prod only, and is shown, not counted, for every other job. Without the secret the health route does not read `last_detail` at all. One row is not a job: `mail-recipients-unreadable` (the `mail_recipients` check reads its age; no cadence list names it, so it never shows under `crons`) |
| **Watchdog + digest** | GitHub issues labelled `ops-incident` / `ops-digest` | incident lifecycle + daily history |
| **RLS cross-tenant audit** | `rls-audit.yml` on migration PRs + weekly cron | FAILs policy-less org-scoped tables & runtime leaks |
| **Supabase Security Advisor** | Dashboard → Advisors (both projects) | accepted floor: 6 WARNs on `is_org_member`/`is_org_admin`/`is_platform_owner` (RLS helpers — **never** revoke their EXECUTE) |
| **Lifecycle E2E suite** | `tests/bot/lifecycle/*` (00-engine … 41-tenant-onboarding) | run against staging before every release |
| **Deploy runs** | Actions: deploy-staging / deploy-prod | red staging deploy = main is broken |

---

## 4. Severity matrix

| Sev | Definition | Examples | Response |
|---|---|---|---|
| **P1** | Learners/admins blocked platform-wide | health `down`; login broken; deploy took prod out | Act immediately; page via `ops-incident`; rollback first, diagnose second (§6.8) |
| **P2** | Major function broken, platform up | email delivery dead; crons stale; a tenant's SSO/custom domain down; LRS backlog exploding | Same day; playbook below |
| **P3** | Degraded/at-risk | dead letters > 0; advisor ERROR; report matviews stale; capacity trending to limit | Within days; open issue with plan |
| **P4** | Hygiene | WARN advisories, flaky test, cost drift | Batch into weekly review |

Escalate P1/P2 to the human with: what broke → evidence (health JSON/log) →
blast radius (which tenants/flows) → recommended action → what approval is needed.

---

## 5. Daily / weekly AI review procedure

**Daily (also what the scheduled routine runs):**
1. `GET /api/ops/health` on prod (full) and staging — compare with yesterday's digest comment.
2. Scan open `ops-incident` issues; for each: still real? root-caused? follow §6.
3. Check latest Actions runs: cron.yml (all 6 jobs green?), ops-watch, deploys.
4. LRS: dead letters > 0 → §6.5. Email: `failed_24h` > 0 → §6.3; with the secret, any `warn` under `email_checks` → §3's table, then §6.2 (`mail_recipients`, `mail_crons`) or §6.3 (`platform_email`, `tenant_smtp`, `mail_jobs`).
5. Post/append findings to the `ops-digest` issue; open issues for anything actionable; **stop and ask** before any §7-gated action.

**Weekly, add:**
6. Supabase advisor re-scan both projects (anything beyond the accepted floor?).
7. Schema drift probe (§6.7) if any migration shipped that week.
8. Capacity: Supabase dashboard (DB size, conn peaks), Cloudflare analytics
   (requests, CPU-time p99, errors), storage growth. Trend, don't just snapshot.
   For the first two weeks of the pilot this is read **every day**, as the
   block below says.
9. Cost: the owner decided on 2026-11-18 to **hold the Workers paid plan**.
   Production and staging stay on the free plan (50 outbound calls and 10 ms
   of CPU for one request); no step may count on an upgrade.
   Supabase plan headroom, including Edge Function calls (each mail is one
   call of `send-smtp`). Any one of these signs reopens the paid-plan
   question (ADR 0029, rule FP9):
   - `mail_jobs`: over 2% of code and link jobs lost in a week, or 5 lost in a day;
   - error 1102 (CPU) or a refused outbound call: over 1% of a day's requests,
     or over 20 a week on the SCORM commit and xAPI statements routes;
   - fewer than 4 mails fit in one request;
   - tenant mail above 750 a day (half the production tenant's limit) on 5 of
     any 14 days, or, once the mail queue is live, one action queuing over 400;
   - a day above half the plan's daily request allowance;
   - a 100-row bulk file needing over 10 minutes;
   - before the mail queue (ADR 0032): "not emailed" counts in an
     administrator's answer on 3 of any 7 days; after it: mail waiting over
     2 hours on 3 of any 7 days, or 10 or more mails a week expiring untried
     while the SMTP and the limit both had room;
   - the repository turns private, or GitHub starts charging a public
     repository for scheduled runs.
10. Post a weekly summary comment (status, incidents, trends, top 3 recommendations).

**The free plan's daily read** (the first two weeks of the pilot; ADR 0029,
rule FP8). Write the numbers into that day's digest comment:
- Cloudflare dashboard → Workers & Pages → the production Worker → Metrics:
  requests for the day, errors and their share of requests, CPU time (p50 and
  p99). Errors 1102 ("exceeded resources") and failed outbound calls are
  requests the platform ended; they record nothing themselves.
- The same Worker → Logs (observability is on in `wrangler.toml`): count the
  fixed lines `platform_call_limit` (a run or a Settings test met the call
  limit), `cron_no_room` (a reminder job stopped itself for want of room) and
  `mail_recipients_unreadable` (mail skipped because its recipients could not
  be read). Note any 1102 on a launch, SCORM commit or xAPI statements route.
- `/super/email`: platform mail sent in 24 hours against the ceiling, lost code
  and link jobs (`n lost of m started`), each organisation's "Sent in 24 hours"
  against its daily limit, and the "Reminder jobs" block.
- Read each number against the signs of item 9.

---

## 6. Incident playbooks (battle-tested on this system)

### 6.1 Health `down` / site unreachable (P1)
1. Confirm blast radius: `curl -s https://<prod>/api/ops/health` (no secret → status only) + open the app in a browser.
2. `down` = DB probe failing → Supabase status page + dashboard (paused project? connection storm? maintenance?). Free-tier projects **pause after inactivity** — a paused prod DB is a 1-click restore.
3. Worker 500s with DB fine → check the last deploy; if a deploy correlates → **rollback first** (§6.8).
4. Cloudflare incident → status.cloudflare.com; nothing to do but communicate.

### 6.2 Cron job stale / cron.yml red (P2)
- **`Cron /api/cron/X returned 404`** → the schedule shipped to `main` before the prod deploy carried the route (GH schedules run from default branch immediately; prod deploys only on tag). Fix: tag the release, or accept red until the next tag. *(Lived: lrs-forward 404s until v1.0.5.)*
- 401/403 → `PROD_CRON_SECRET` repo secret ≠ worker's `CRON_SECRET` (rotated one side only).
- Heartbeat stale but cron.yml green → route ran but errored inside; check the run's response body, then the job's `last_detail` in `ops_heartbeats`.
- **`Cron /api/cron/reminders returned 500`** with `ok: false` → one of the job's own steps failed: a database read or write, an organisation whose members could not be read (`unreadable_orgs` above zero in the run log), or the call limit (`stopped_before_send` true when it stopped before any mail). Nobody in an unreadable organisation was reminded and no reminder state was written for them; the other organisations finished unless the run stopped before sending. The heartbeat reads `error`, and the organisation's id is only in the `mail_recipients_unreadable` log line. With ADR 0029 pull request B's code, `reminders` is in `ERRORED_WARN`, so on prod the overall status reads `warn` until the job's next clean run: read it as "A yellow page from a reminder job" below. (Code from before that pull request leaves the overall status where it was and shows the job as `last-run-errored` in the crons detail, read with the secret.) The next daily run is the retry; a repeat is a database fault or the call limit. A run the platform itself ended writes no heartbeat: it shows as this red run, then as a stale heartbeat. (ADR 0030, note "Pull request B build decisions", change 2; ADR 0029, notes of 2026-11-20 and 2026-11-21.)
- **`Cron /api/cron/journey-nudges returned 500`** with `ok: false` → the same for the journey reminders: an unreadable organisation's programs were skipped (also counted in `skipped_org_programs`) and none of their learners was claimed or mailed. Read it as the line above; the next hourly run is the retry.
- **A yellow page from a reminder job** (`reminders` or `journey-nudges`; ADR 0029, note of 2026-11-20, part 2):
  - *What it means.* On prod (`OPS_EXPECT_CRONS=1`) the job ran recently and its last run failed: a database read or write of the job itself went wrong, an organisation could not be read, or it met the call limit. A run still reads clean when the trouble was not the job's own: mail a tenant's server refused, or a tenant not ready (both show under `tenant_smtp`); a daily limit reached; organisations or programs held over to the next run for lack of room; an organisation that is paused or deleted; a database that lacks 0114. The word `warn` on `crons` is public (the watchdog's summary prints it); the details never are.
  - *Where its three items are read.* `/super/email` → "Reminder jobs": for each job its state, last run, **last successful run**, **pending reminders** and **failure details**, in fixed sentences. With the secret, the same under `email_checks.mail_crons.jobs.<job>` of `GET /api/ops/health`. Without the secret only the status word is answered. The heartbeat's `last_detail` holds counts and fixed words only (`errors` counted by step word, `failed_steps`, `unreadable_orgs`, `stopped_before_send`, `due`, `sent`, `failed`, `left`, `left_complete`, `left_daily_limit`, `left_orgs`, `no_0114`, and `last_ok_at` on a failed run); ids and the database's message are only in the Worker's log line. "Last successful run: not known" means the row predates this code or the run could not read its previous row; the next clean run sets it. Pending reminders read as a number, "at least n" (the run could not count everyone), or "not known: the run failed before it counted"; a number left out is never shown as 0.
  - *How it clears.* By the job's next clean run, and only that: the next day's run for `reminders` (or by hand: Actions → "Scheduled crons (prod)" → Run workflow → `/api/cron/reminders`), the next hour for `journey-nudges`. Nobody clears it in the database. A job with no run at all reads by the staleness rules instead (`reminders` past 26 h reads `degraded`). Staging has no schedule, so there the status never turns yellow and the block says "Not scheduled here: shown, not counted."; a run by hand on staging is `node scripts/staging-cron-post.mjs <reminders | journey-nudges>`.
  - *By sentence.* "The job could not read who is due within one call, so nothing was sent. Waiting does not clear this." (`call_limit` with a stop before sending): an organisation too large for one call; it fails every day until the code changes, so send it to the architect with the run's counts. "The job met the platform's limit on calls part-way through …": the next run continues; a repeat is a capacity question (§5 item 9). "A record of mail that went could not be written, so that mail can go again." (`state_write`): check the database; one reminder or escalation may go twice. "n organisations could not be read …": a database fault or the call limit; the ids are in the `mail_recipients_unreadable` log lines. "n organisations or programs waited for the next run." on a clean run: room ran out; not yellow, and pending reads "at least n". "This database has no migration 0114 yet …": normal on prod until its sitting for 0114; the run is clean, with no daily limit and no email state recorded.
- **`email_checks.mail_recipients` reads `warn`** → in the last 24 hours a request (an assignment, a ticket, an extra-attempt request and the like) kept its own change but mailed nobody, because the read of its recipients failed. The row `mail-recipients-unreadable` in `ops_heartbeats` names the site in its `last_detail` (one fixed word); the Worker's `mail_recipients_unreadable` log line names the organisation. An administrator at the screen was told at once; a learner's request still shows in the app and the Attention Center. It clears by itself 24 hours after the last skip; a repeat is a database fault. The row is not a job and never shows under `crons`. It needs no migration, so it reads the same before and after the 0114 and 0117 sitting. The two reminder jobs never write it: their skips fail their own run (above).
- GH Actions outage/jitter → verify at githubstatus.com; cadence thresholds already absorb minutes of jitter. GitHub starts only a share of the frequent schedules (gaps of up to about 10.5 h per job measured in Nov 2026), so a stale frequent job reads `warn`, not `degraded`, while its last run is less than 26 h ago; past that, treat it as a real fault.

### 6.3 Email delivery broken (P2)
1. Triage source: `notification_log` — group recent `failed` rows by `error`.
2. **SMTP 535 BadCredentials** → tenant's Gmail app password revoked/rotated (Google silently kills them on password change). Fix: regenerate 16-char app password, update tenant SMTP settings, send test (Settings → SMTP → "Send test"; a delivered test clears the organisation's reading, §6.3b). *(Lived: ALL Ambak mail dead for weeks.)*
3. **No fallback** (ADR 0029 section B). A tenant's mail goes only through that tenant's own SMTP, and platform mail only through the platform mailbox (§6.3a). When that sender cannot deliver, the row reads `failed` and its message points at the organisation's SMTP settings; nothing else is tried, and nothing else is configured.
4. Junk-foldering (delivered but unseen) → SPF/DKIM/DMARC missing on the From domain; align display name; long-term: a verified sending domain on the tenant's own mailbox.
5. Reset codes and sign-in links follow the account (ADR 0029 section A, rule 2). Platform owners and organisation administrators (`super_owner`, `admin`) get theirs from the platform sender on every page. Everyone else gets theirs through the SMTP of the organisation whose sign-in page they used, as its member. So a tenant SMTP failure stops its learners' codes and links, not its administrators'.
6. The `email` health check counts only events that a signed-in person or the system starts, so it leaves out `password_reset` and `magic_link` rows (ADR 0029 section H), and rows with the error `daily_limit`. Read those in `notification_log` directly; the organisation's reading (§6.3b) covers them.

#### 6.3a The platform sender (ADR 0029; `lib/email/platform-sender.ts`)

The platform's own mailbox: a mailbox of the LMS owner's, opened only by the
owner, with two-step verification. If it also carries other mail, that mail
uses the same daily sending cap (step 3). It sends platform mail only
(platform owners' and organisation administrators' codes and links,
administrator welcomes, SMTP alerts); never a learner's mail, and it is never
a fallback for a tenant's SMTP, nor a tenant's SMTP for it. It posts to the
`send-smtp` function like a tenant send; every send is one row of
`public.platform_email_log` (migration 0113: user ids, statuses and error
classes; never an address or message content). A code or a link claims its
limits before the send: its first row is the claim (`suppressed` with the
error code `pending`), its second what came of it. A `pending` row is never a
send: the health check and "Last send" on `/super/email` do not read it.

**Setup** (staging first; production in the sitting before the tag that
carries the sender, ADR 0029 section M):
1. Migration `0113_platform_email_log.sql` pasted on the database **before**
   the code (decision 7). Code that arrives first sends nothing and reads
   `fail` until the paste.
2. The settings, every one a deployment secret (never in the database, the
   repository, a page or a chat): `PLATFORM_SMTP_HOST`, `PLATFORM_SMTP_PORT`
   and `PLATFORM_SMTP_SECURE` (465 and `true` for Gmail), `PLATFORM_SMTP_USER`,
   `PLATFORM_SMTP_PASSWORD` (the mailbox's app password), `PLATFORM_SMTP_FROM`
   (`Name <address>`) and `PLATFORM_EMAIL_ALLOW_DOMAINS` (`*` on production;
   on staging a list of exact addresses, see "The allow-list" below); optional
   `PLATFORM_EMAIL_REPLY_TO`, `PLATFORM_EMAIL_DAILY_CEILING` and
   `PLATFORM_EMAIL_ORG_DAILY_LIMIT`.
   Workers: `wrangler secret put <NAME>` (`--env production` for production;
   comments in `wrangler.toml`). Cloud Run staging is retired (ADR 0037).
   Staging and production never share a credential.
3. **The ceiling.** `PLATFORM_EMAIL_DAILY_CEILING` is three quarters of the
   mailbox's daily sending cap. The platform mailbox is a personal Google
   mailbox (about 500 a day), so production's ceiling is **375**, the owner's
   figure; unset, the sender uses 375 too. Each environment has its own app
   password, but where staging's and production's both belong to the same
   mailbox the provider adds both environments' mail up: staging's ceiling is
   then **25**, keeping the mailbox's total to 400 a day. A staging mailbox of its own
   takes three quarters of its own cap. Mail the mailbox sends outside the LMS
   counts against the same cap.
4. `/super/email` → "Send test to my address": the message arrives and the
   page reads configured, `ok`. Then `/api/ops/health` with the secret:
   `email_checks.platform_email` `ok`.
5. Staging only, once, after step 4: the timing measurement of ADR 0029
   section G, `node scripts/measure-platform-send.mjs` (its header has the
   steps). It reports the 95th-percentile send time; a figure above 4 s is
   reported before ADR 0029 pull request B.

**The allow-list** (`PLATFORM_EMAIL_ALLOW_DOMAINS`; ADR 0029, notes of
2026-11-20 and 2026-11-21). A list cut at commas and white space. Each entry is
one of three things:
- `*`: every address. Production's value, and it is not changed.
- An exact address, `<local>@<domain>`: only that address, matched in full
  and without regard to letter case. No other folding happens, so a "+tag"
  form or a dotted spelling counts as a different address and needs its own
  entry.
- A domain, `<domain>` or `@<domain>`: every address at it. Staging lists none.

Any other entry is ignored and allows nobody. If no entry is usable the list
counts as unset: nothing is sent, `/super/email` names the variable
under "Missing or invalid", and `platform_email` reads `fail`. `*` beside other entries allows
everything. Reserved test domains are never mailed, whatever the list holds,
and tenant mail is never read against the list.

Staging's value, set on the staging Worker only (ADR 0037). The
real addresses are typed only into its secret, never into a file, a page,
a commit or a chat:
```
<send-test-local>@<send-test-domain>,<test-mailbox-local>@<test-mailbox-domain>,<test-mailbox-local>+p0029h-welcome@<test-mailbox-domain>,<test-mailbox-local>+g1-alert@<test-mailbox-domain>
```
| Entry | Whom it serves |
|---|---|
| `<send-test-local>@<send-test-domain>` | "Send test" on `/super/email`: the test goes to the address of the platform-owner account that presses the button on staging. Not needed when that account uses the test mailbox's address |
| `<test-mailbox-local>@<test-mailbox-domain>` | the test mailbox's own address; nothing automated mails it, it is there for manual checks |
| `<test-mailbox-local>+p0029h-welcome@<test-mailbox-domain>` | the platform leg of the setup-link proof (point 6): an administrator added on the console at this alias, whose welcome and link are then checked in the mailbox. It carries the prefix of `scripts/check-auth-setup-link-proofs.mjs`, whose first step removes any account left at that prefix; that script does not run this leg yet |
| `<test-mailbox-local>+g1-alert@<test-mailbox-domain>` | gate G1 (b): the single administrator, in the gate's test organisation, who receives a real SMTP alert. The person running the gate removes that account afterwards, since no automatic cleanup touches the mailbox's domain |

Nobody else on staging receives platform mail: their codes, links and alerts
are logged as `suppressed` with `not_allowed`, and they use their password to
sign in. Only the owner adds a name to the list, one address per entry.
Setting it: on the staging Worker, `wrangler secret put
PLATFORM_EMAIL_ALLOW_DOMAINS` takes effect immediately. Cloud Run staging
is retired (ADR 0037): no secret is added there, and the staging
Worker is the only staging deployment that reads this list.
Then "Send test". Code from before ADR 0029 pull request B
reads an address entry as a domain that matches nobody: with only address
entries it sends no platform mail at all, and "Send test" reads not sent there
until that pull request's code is deployed.

**Rotation:** set `PLATFORM_SMTP_PASSWORD` again (Workers: `wrangler secret
put`), then "Send test".

**Dead app password** (`platform_email` `fail` with the newest row `auth`;
console banner): Google withdraws an app password when the account's password
changes or two-step verification is reset. Sign in to the mailbox, create a new
app password, rotate as above, send the test; the delivered test clears the
check. `quota`: the provider's daily cap is reached; it clears by itself
within 24 hours; lower the traffic or raise the cap, and keep the ceiling at
three quarters of the cap. `timeout` once is `warn`: the mail may still have
arrived (the app waits 15 s for one send, in both systems; `send-smtp` keeps
trying for up to 25 s).

**Limits** (ADR 0029 section G; checked before every send, and a limit that
cannot be read sends nothing): 5 an hour and 10 a day for every account and
kind, a platform owner's own included (the test counts only the sends that
reached the mail server); 50 codes and links a day for one
organisation's administrators (`PLATFORM_EMAIL_ORG_DAILY_LIMIT`; alerts and
welcomes are outside it); the daily ceiling for all platform mail. A platform
owner's own code, link and test are exempt from the organisation's share and
the ceiling. Each platform owner account can send up to 30 messages a day past
the ceiling (ten codes, ten links, ten tests). The ten tests are counted one
at a time: send one test and wait for its answer before the next. Keep the
ceilings of the environments that share the mailbox, plus 30 for each
platform owner account,
under the mailbox's daily cap. Nothing is ever sent to a reserved test domain
(`.test`, `.example`, `.invalid`, `.localhost`, `example.com/.net/.org`), and
nothing at all while the allow-list is unset.

**Retention:** rows are kept 90 days. Monthly, in the SQL editor with the role
selector on postgres:
```sql
delete from public.platform_email_log where sent_at < now() - interval '90 days';
```

**Retention of setup links** (`public.account_setup_links`, migration 0117; the
LMS's own "set your password" links). Monthly too, in the same place, with this
statement and no other:
```sql
delete from public.account_setup_links l
 where l.created_at < now() - interval '90 days'
   and exists (
     select 1 from public.account_setup_links n
      where n.user_id = l.user_id
        and n.organization_id = l.organization_id
        and (n.created_at, n.id) > (l.created_at, l.id));
```
It removes a row older than 90 days only when the same account holds a newer
row for the same organisation. So the **newest row of each account in each
organisation is kept**, at any age and in any state, until the account or the
organisation is deleted: "Send setup link" is offered only where such a row
exists, and what held a link back (a paused organisation, a mailbox not yet
ready, a person added as inactive) can last longer than 90 days. Of two rows
with the same time, the one with the higher id counts as the newer. **Never use
the short form** that deletes every row older than 90 days with no other
condition: it would take that action away from a person who has not set a
password yet (they would then need "Forgot password?"). A kept row holds ids,
times and the hash of a link that expired long ago; no link outlives 7 days, so
it opens nothing. The statement is word for word the one in the header of
`supabase/migrations/0117_account_setup_links.sql`, and a unit case holds the
two equal (`tests/unit/setup-link.test.ts`). On a database without 0117 there is
nothing to clear.

**Last resort** for a locked-out platform owner or administrator (the sender
or its log down, or the account's hourly limit reached): the
owner sets a temporary password for the account in the hosted auth dashboard.
It stays the last resort after ADR 0029 pull request B; a learner asks their
administrator, who asks the platform owner.

#### 6.3b A tenant's SMTP state and daily limit (ADR 0029 sections C, E and G; rule FP4; migration 0114)

**The reading.** Each organisation has one: `not_configured` (host, port or
From missing, or the organisation deleted), `configured` (complete, nothing
sent yet), `healthy` (the newest test or send was delivered) or `failing`. Its
administrators see it on Settings → SMTP (with the last error class, "Send
test" and "Sent in the last 24 hours: n of the limit of m"), in the banner of
the admin pages and as the critical `tenant-smtp` item of the Attention
Center. The platform owner sees every organisation on `/super/email` →
"Organisations' email"; ops see the counts in `email_checks.tenant_smtp`.
- **To `failing`:** a failed Settings test, at once; a real send that fails
  with the class `auth` or `quota`, at once; `timeout`, `unreachable` or
  `unknown` only after three different people in a row with no delivery
  between. A `rejected` send (one recipient's server refused it) changes
  nothing. A delivered test or send clears it. A Settings save that changes an
  SMTP field sends the test to the saving administrator in the same request.
- **While an organisation is not ready** (`failing`, `not_configured`, or at
  its daily limit): its learners' reset codes and sign-in links are not
  attempted, and its sign-in page answers "Email could not be sent. Please
  contact your LMS Administrator." For each account and kind, only the first
  such request in a 24-hour window leaves a `failed` row (error `smtp_not_ready`,
  or `daily_limit`). A code or link that is attempted first writes its claim, a
  `queued` row with the error `claim`: it queues nothing, holds no credential
  and never counts as sent. What happens to its other mail depends on why it is not
  ready:
  - `failing`: the other mail is still tried, and the first send acts as the
    probe. In one request or cron run the organisation gets one probe; once a
    run's sends flip it, the rest are not attempted and are recorded as not
    sent.
  - `not_configured`: nothing can be tried, because the settings are not
    complete.
  - at its daily limit: nothing at all is attempted through its SMTP and there
    is no probe, whatever its reading; routine mail had already stopped short
    of the limit (see "The daily limit" below).
- **The alert.** `tenant_smtp_alert` goes by the platform sender to at most
  five of the organisation's active administrators. Three things raise it: the
  reading turning `failing` (no more than once per 6 hours); a learner's mail
  held back while the organisation was not ready (no more than once per 24
  hours); and routine mail halting at the daily limit. Requests only flag the alert as due; it is
  the hourly `journey-nudges` call that mails it, one alert per call at most. Staging has no
  schedule: there it goes only with `node scripts/staging-cron-post.mjs
  journey-nudges`. A deleted organisation is never alerted.

**The daily limit.** Counted over the last 24 hours (no midnight) from the
organisation's `sent` rows in `notification_log`, test sends included.
- **Where it is set:** by a platform owner on `/super/email`, column "Daily
  limit": type the number and press Save, or press "Use the default" to go
  back to the default; an empty or unreadable box is refused, never saved as
  the default. Each change writes a `platform_audit_log` row. Tenant administrators
  see it and cannot change it. Where none is set: `TENANT_EMAIL_DEFAULT_DAILY_LIMIT`
  if the environment sets it, else **375**. The production tenant's is
  **1,500**: the owner enters it on `/super/email` after the release that
  carries this code is live, then checks the organisation's SMTP tab shows it.
- **The reserve:** one tenth of the limit (rounded up, never under 25) stays
  free for mail someone is actively expecting: reset codes, sign-in links,
  welcome mail, setup links and the Settings test. Everything routine (reminders,
  nudges, broadcasts, and the assignment, update, completion, ticket and
  attempt-request messages) halts once the limit minus that reserve is reached: 1,350 of 1,500, 337 of 375. From eight
  tenths the Attention Center item warns; when routine mail stops it is
  critical and one alert is due. A limit of 25 or less is all reserve:
  routine mail never goes at it. The route accepts it (1 to 100,000), the
  form says so when it is saved, and the console, the banner, the Attention
  Center item and the SMTP tab read "routine mail off at this limit", a
  warning, not a stop for today. At the limit nothing more is attempted
  through that SMTP until earlier mail is 24 hours old, and the organisation
  reads not ready. The platform mailbox is never used instead.
- An administrator's own send reports `not_sent` with the class `daily_limit`;
  it is not an SMTP failure and does not move the reading. A reminder job that
  stops for it says how many it left (`left_daily_limit`) and sends them later.
- A `quota` refusal from the tenant's own provider before the limit is reached
  means the mailbox allows less than assumed: lower the limit to 75% of what it
  really allows.
- **One mailbox, one environment.** No staging organisation is ever given a
  production mailbox.

**Before and after the 0114 and 0117 sitting.** Staging has both files;
production is to receive them in its own dedicated sitting, ahead of the tag that carries pull
request B's code (`docs/MIGRATIONS.md`). The code also runs on a database
without them (a deploy ahead of the sitting, or after a reverse):
- *Without 0114:* no reading is stored and no alert is marked; every
  organisation with complete settings is treated as ready; no daily limit is
  applied (the send is attempted and an error class logged); no code or link
  job is counted. `tenant_smtp` and `mail_jobs` read `unknown` and the overall
  status does not move. `/super/email` shows one line naming migration 0114 in
  place of the organisations and their numbers, and a limit cannot be set (the
  route answers with the same line). A reminder job's run is clean and its
  details say "This database has no migration 0114 yet …".
- *Without 0117:* the console refuses to add a new account with no password,
  before any account is made, with a message that names the migration; an
  account that already exists is added as before; "Send setup link again" is
  refused the same way; and every setup link reads as not usable. A reset or a
  password change still succeeds.
- *With both:* everything in §6.3a and §6.3b as written. On staging, where both
  are pasted, a fallback taken is a fault: a reminder job's details showing
  `no_0114`, or `tenant_smtp` and `mail_jobs` reading `unknown`, mean a call
  reached the database by a wrong name; send it to the architect.

### 6.4 RLS audit FAILED (P2, security)
- Usually a **new org-scoped table with RLS on and zero policies** — the audit can't certify isolation (not necessarily a leak: policy-less = deny-all). Fix: migration adding `for select using (is_org_admin(organization_id))`-style policies; apply to staging (audit runs against staging live) then prod. *(Lived: 0044 → fixed by 0045.)*
- A **runtime leak** (cross-tenant rows visible) is a real P1: pull the offending policy immediately, then root-cause.
- Never "fix" advisor WARNs by revoking EXECUTE on `is_org_member`/`is_org_admin`/`is_platform_owner` — every RLS policy calls them; the app dies instantly.

### 6.5 LRS forwarding backlog / dead letters (P2/P3)
1. Health `lrs_outbox.detail` → which org? `select organization_id, status, count(*) from lrs_forward_outbox group by 1,2`.
2. `last_error` tells the class: 5xx/network = tenant LRS down (retries handle it; backlog drains itself); 401/403 = tenant rotated LRS creds → ask tenant admin to update Settings → External LRS (connection test button); dead letters = exhausted retries → after fixing the cause, reset with `update ... set status='failed', attempts=0, next_attempt_at=now() where status='dead' and organization_id=...` (service role; get approval).
3. Force a drain anytime: `POST /api/cron/lrs-forward` with `x-cron-secret`.
4. Health `warn` with `lrs-forward`'s heartbeat `last_status` `error` (job state `last-run-errored`; a stale heartbeat shows `stale` instead) → the drainer's preview check or its park write failed. `last_detail.reason` names which and counts rows (`preview check failed: held N`, `park write failed: N of M not parked`); the error text is in `previewCheckError` or `parkError`. The held or unparked rows stay due and are checked again on the next run; none is posted. The next clean run clears the warn. If it persists, the `course_attempts` read or the outbox update is failing: check the DB. ADR 0024, note of 2026-11-15.
5. Ingestion is fail-isolated from forwarding by design — internal LRS keeps recording even when forwarding is broken; learner data is never at risk from a tenant's LRS outage.

### 6.6 Reports stale / matview refresh failing (P3)
- `refresh-report-views` heartbeat errored → usually a matview missing on that env (schema drift) or a concurrent-refresh lock. Probe `to_regclass('public.mv_course_performance')` etc.; replay canonical migrations (0031, 0035) if missing. 0031 is on 0115's never-paste list (6.7): on a database that holds 0115, paste 0115 again directly after it and run `ops/0115-after-checks.sql`. *(Lived: prod had 0035 but not 0031; refresh errored nightly.)*

### 6.7 Schema drift staging↔prod (P3, release-blocking)
- Before every prod release: run `to_regclass()`/`to_regprocedure()` probes for objects the release's code reads. Any NULL on prod = apply the missing canonical migrations first (they're idempotent), **then** tag.
- Write new hand-applied DDL drift-safe so partial states no-op instead of aborting.
- **Membership rule (ADR 0030, migration 0115).** Idempotent is not the same as safe to paste again: After 0115, none of 0001, 0002, 0006, 0010, 0019, 0026, 0027, 0030, 0031, 0055 and 0056 is pasted again on that database. If one is pasted, 0115 is pasted again directly after it, in the same sitting, and its after-checks are read. Where 0110 is applied and the file was 0027, 0110 follows 0115. A paste of 0105, 0106, 0107, 0108 or 0112 needs nothing from 0115. The after-checks of 0115 are also kept as a read-only block that can be run alone (`ops/0115-after-checks.sql`); it is run after every sitting that pastes a migration, whatever its number. A failed after-check names the helper or policy that lost the rule; paste 0115 again, then run the after-checks again.
- **Hand-made databases (ADR 0030, note of 2026-11-18).** A database set up by hand before the repository's migrations can carry other policy names. 0115's before-check marks two closed lists: `RENAMES` (the aliases "members_view_their_orgs" on `organizations` and "View own membership" on `organization_members`; the paste gives them the repository's names, and nobody's access changes by that) and `DROPS` (only "admins_view_org_enrollments" on `public.enrollments`, a table outside the repository; the paste removes that one policy and its `B11` row keeps its whole text). Both rows go to the owner before every paste. Anything off the lists still reads `REFUSES` or `UNEXPECTED`: no paste, back to the architect; a list is widened only by a dated note under ADR 0030 with its rehearsal, never at the SQL editor. Row security off on `public.enrollments` is a finding of its own for the owner (the before-check's `B12` row reads `LIST` and prints the table's select, insert, update and delete grants for `anon` and `authenticated` and its other permissive policies by name); it does not hold the paste. The reverse renames nothing back and never restores the removed policy; after it, only the `B11` row of "members_view_their_orgs" is run; that of "View own membership" is printed in parts, not as a statement, and is never written back.

### 6.8 Bad deploy / rollback (P1 path)
- Prod deploys are tag-driven: **rollback = re-run deploy-prod on the previous good tag** (Actions → deploy-prod → run on tag `vX.Y.(Z-1)`), or `wrangler rollback` for the worker alone.
- DB migrations don't auto-rollback — that's why DDL ships **before** the tag (expand-contract): new code must tolerate old schema for one release.
- After rollback: watchdog should flip the incident to recovered within 10 min; then diagnose on staging.

### 6.9 Suspicious activity / security event (P1/P2)
- Evidence: Supabase auth logs (mass failed logins), `platform_audit_log`, unexpected `platform_owners`/`organization_members` role grants, advisor regressions.
- Contain: suspend the tenant (billing_status) or disable the credential; rotate exposed keys (service role key = full bypass — treat leak as P1); then investigate.
- Never delete evidence; snapshot first (backup, §8).

### 6.10 Completion sweep red or backlogged (P2/P3; from 0107 and 0112)
The completion sweep is the only retry of the fail-closed completion writer (points, path and journey credits, completion claims). From migration 0112 (ADR 0024, note of 2026-11-16) both refresh routes drain it first, in calls of their own (`lib/ops/completion-sweep.ts`), and each refresh function also sweeps for at most 1.5 s.
- **Read `completion_sweep_drain`** in the body and the heartbeat `last_detail` of `gamification-refresh` (up to 4 calls a run) and `refresh-report-views` (up to 8): `{calls, candidates, handled, failed, stalled, stopped, ms}`, counts only (no ids). `stopped`: `done` the queue ended; `busy` another sweeper held the key (the other route, staging's nightly refresh or staging job) — normal; `time` or `limit` the run used all its calls with rows left — the next run continues; `stalled` two calls in a row handled 0 rows and failed some; `error` a call failed (the message is in the top-level `error`); `absent` the database has no 0112 (PGRST202) — normal on production until the 0112 paste. The refresh entry `completion_sweep` (last in the answer) has its own `sweep` with the same `stopped` word.
- **Red with `completion_sweep: stalled (N failed, 0 handled, 2 calls)`** → failing rows fill the head of the queue (it is oldest first) and nothing behind them is reached. See which rows and why in the SQL editor (role postgres): `select public.sweep_completion_side_effects_timed(5, 5000);` — its `errors` hold up to five `{attempt_id, sqlstate}`. `55P03` = a lock wait past the sweep's 1 s `lock_timeout` (something holds those rows; find it in `pg_stat_activity`); any other code = a writer fault on those rows (escalate; never edit attempt rows by hand). One stalled call alone never reads red.
- **Red with `completion_sweep: drain function not visible`** → 0112 is applied but the Data API cannot see `sweep_completion_side_effects_timed`: run `notify pgrst, 'reload schema';` and check its grant (`service_role` execute). Then POST the route once by hand.
- **Red with `completion_sweep: <57014 or another error>`** → a drain call or the refresh's own sweep failed. With the box a 57014 means a single row ran past the statement timeout; read the role's timeout (`select rolname, rolconfig from pg_roles where rolname in ('authenticator', 'service_role', 'postgres');`) and the queue's head as above.
- **Drain by hand** (SQL editor, role postgres; service role through PostgREST works the same): read `select public.completion_sweep_backlog();` (`{candidates, oldest_at}`), then run `select public.sweep_completion_side_effects_timed(200, 5000);` once per execution — each run is its own statement and commit — until it answers `stopped` `done`; read the backlog again. `busy` → another sweeper is running: wait a few seconds and run it again. Rows in `failed` stay in the queue and are retried by every later call. Keep one call per execution: a statement-timeout cancel rolls back everything its execution did, so a batch of calls in one execution could lose them all.
- **Staging only**: if the owner scheduled the staging job of the ADR 0024 note of 2026-11-16 (D-S3), `select jobname, schedule, command from cron.job;` shows `completion-sweep` every 15 minutes; `select cron.unschedule('completion-sweep');` removes it (do so before `ops/0112-reverse.sql` or `ops/0107-reverse.sql`, in the same sitting: both drop the function the job calls, and every later run would fail with 42883).

---

## 7. Safe-actions policy (AI autonomy boundaries)

**Autonomous (no approval):** read-only queries via service role; hitting health/cron
endpoints with the secret; re-running failed workflows; opening/commenting/closing
`ops-*` issues; drafting PRs (code, migrations, docs); running the lifecycle suite
against **staging**; creating qa-prefixed test data on **staging** (clean up after).

**Requires human approval:** any DML/DDL on **prod**; resetting dead letters;
deleting/suspending tenants or users; rotating secrets; tagging releases;
changing billing/plans; anything irreversible or tenant-visible.

**Forbidden:** test/seed data on prod; force-push; disabling security gates
(rls-audit, advisor fixes); revoking EXECUTE on the RLS helper functions;
committing secrets.

---

## 8. Backups & DR

- Supabase dashboard backups per project (free tier: none automated on nano —
  see §9). Manual: Dashboard → Database → Backups before risky changes.
- Prod dumps contain PII → **never** commit (gitignored); local copies temporary.
- DR truth: code = git tags; schema = `supabase/migrations/*` (canonical, idempotent);
  data = Supabase backups. Restore order: project → migrations replay → tag deploy.
- Weekly review verifies: latest backup exists and is recent (dashboard check).
- Course files: nightly copy to an Object-Locked B2 bucket. It compares sizes only, so a change that keeps the size shows only in a drill naming that folder. To prove a download from it byte for byte, run **Nightly content backup** by hand with `restore_drill` (`docs/CONTENT_STORAGE.md`, "Backup and rollback").

## 9. Scale readiness — 25,000 users (pre-launch gate)

Current reality: prod Supabase is **FREE tier on t4g.nano (60 direct connections)**
and the worker runs on **workers.dev**. That does not survive 25k users. Before
go-live:

| Item | Why | Target |
|---|---|---|
| Supabase → Pro + compute upgrade | nano's conns/CPU die under classroom-start spikes; free tier pauses + no PITR | Pro, ≥ small/medium compute, PITR on, **pooled connections (Supavisor port 6543)** |
| Workers paid plan + custom domain | workers.dev is rate-limited/unbranded; move to owned domain + CF proxy. The free plan gives one request 50 outbound calls and 10 ms of CPU, on staging and production alike | Paid plan **on hold** (owner, 2026-11-18): the pilot is run on the free plan, with no dependency on an upgrade; it is looked at again on any sign of §5 item 9. The custom domain: ADR 0031 |
| Email: every tenant on its own SMTP, under a daily limit | a mailbox's provider caps its daily sends (a Google Workspace mailbox about 2,000, a personal one about 500); one large tenant's reminders could pass that | each tenant sends through its own SMTP only, under its daily limit (production tenant 1,500; §6.3b); platform mail through the platform mailbox, 375 a day (§6.3a); no fallback. Watch `email.sent_24h` and, with the secret, `email_checks.tenant_smtp` |
| Load test the hot paths | login burst, SCORM commit storms (every learner every few seconds), report pages | k6/artillery vs staging at 2× expected peak before launch |
| Observability upgrades | 10-min probe is MTTR-bounded; JS errors invisible | Cloudflare Workers analytics review, Supabase log drain, Sentry (optional but recommended) |
| Storage growth | packages × versions accumulate (size_bytes tracked per version) | monitor via tenant_usage; prune superseded versions policy |

## 10. Communication contract

- **Real-time:** `ops-incident` issues (watch the repo → email/mobile push).
- **Daily:** digest comment (01:30 UTC / 07:00 IST) + AI daily review findings.
- **Weekly:** AI weekly summary (trends, capacity, top recommendations).
- **Release:** drift probe + lifecycle suite green + advisor clean = go.
- Alert style: what broke → evidence → blast radius → action taken/proposed →
  approval needed. No alert without a next step.

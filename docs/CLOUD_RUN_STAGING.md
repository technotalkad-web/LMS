# Cloud Run trial staging (Google Cloud credits)

> **Retired 2026-11-27 (ADR 0037).** The Cloud Run staging trial is stopped and
> will not be used again. The Workers staging is the only deployed staging
> environment; a check its free plan cannot finish runs on an in-runner build
> (`scripts/lifecycle-nightly.sh`, `scripts/e2e-in-runner.sh`). Do not run
> `scripts/cloud-run-deploy.sh`, and do not create or rotate secrets for this
> service. The rest of this page is kept as history only.

**Decisions (2026-09-26):** dedicated Google Cloud project, **staging**
Supabase only, temporary `run.app` URL for now (custom domain later, before
any real-user rollout), Cloudflare left untouched, CI and crons NOT
repointed yet. No production keys, no real learner traffic.

Why: the Cloudflare Workers free plan caps every request at 10 ms CPU, so
staging throws error 1102 at random. Cloud Run has no per-request CPU cap.
Nothing about the data moves — users, progress, attempts, statements and
files stay in Supabase — so going back to Cloudflare later is a URL change.

Files: `Dockerfile`, `.dockerignore`, `cloudbuild.yaml`,
`scripts/cloud-run-deploy.sh`. The Cloudflare build is unaffected:
`next.config.ts` only switches to `output: "standalone"` when the container
build sets `NEXT_OUTPUT=standalone`.

What behaves differently on Cloud Run (all designed to degrade safely):

| Feature | On Workers | On Cloud Run |
| --- | --- | --- |
| Course content delivery | streamed + Cloudflare edge cache | streamed from Supabase storage / R2, no edge cache |
| External LRS forward | immediate + 5-min cron | 5-min cron only (once crons are pointed here) |
| First request after idle | instant | 2–5 s when `MIN_INSTANCES=0` |
| Per-tenant custom domains (Cloudflare SaaS) | supported | not available (trial does not need it) |

Everything else — sign-in, dashboards, SCORM / cmi5 / xAPI launches and
resume, uploads (browser-direct), reports, journeys, gamification, the LRS
sweeper — runs identically. Verified: the standalone build serves the
staging login pages and the authenticated dashboard, users, announcements
and analytics pages.

---

## 0. Where to run the commands

Use **Cloud Shell** (the terminal icon at the top right of the Google Cloud
console): it already has `gcloud`, `git` and Docker tooling, so nothing is
installed on a laptop. Everything below is pasted into it. If you prefer a
local machine, install the gcloud CLI and run `gcloud auth login` first.

## 1. Create the dedicated project and attach the credits (10 min)

The $300 trial credit lives on the **billing account** created when the
free trial started; the new project just has to be linked to it.

```bash
# 1. project id must be globally unique: keep the prefix, change the suffix if taken
PROJECT_ID="lms-cloudrun-trial-01"
gcloud projects create "$PROJECT_ID" --name="LMS Cloud Run trial"
gcloud config set project "$PROJECT_ID"

# 2. link the billing account that carries the credits
gcloud billing accounts list                        # copy the ACCOUNT_ID that shows OPEN=True
gcloud billing projects link "$PROJECT_ID" --billing-account="XXXXXX-XXXXXX-XXXXXX"

# 3. enable the services the trial uses
gcloud services enable run.googleapis.com cloudbuild.googleapis.com \
  artifactregistry.googleapis.com secretmanager.googleapis.com

# 4. a Docker image repository in Mumbai (closest region to the users)
gcloud artifacts repositories create lms --repository-format=docker \
  --location=asia-south1 --description="LMS images"

# 5. let Cloud Build push images and let the runtime read secrets
PN=$(gcloud projects describe "$PROJECT_ID" --format='value(projectNumber)')
gcloud projects add-iam-policy-binding "$PROJECT_ID" \
  --member="serviceAccount:${PN}-compute@developer.gserviceaccount.com" \
  --role="roles/artifactregistry.writer" --condition=None
```

**Budget alert (console, 2 min):** Billing → Budgets & alerts → Create
budget → scope = this project → amount $100 → alerts at 50 / 90 / 100 %.
Credits are consumed silently otherwise. Confirm on the same page that the
credits show under *Credits* for this billing account; the Google AI Ultra
monthly credit only helps if it is also attached to this billing account.

## 2. Secrets (never in files, chat or build args)

Three values, all for the **staging** Supabase project
(`zeaclbapadosqqttexxh`), from the developer's `.env.local` in the repo
folder, or: the service-role key from Supabase → Project Settings → API
(staging project); the other two can be freshly generated for this
environment (`openssl rand -hex 32`) because nothing else needs to match
them until the crons are pointed here.

```bash
printf '%s' "<STAGING SUPABASE_SERVICE_ROLE_KEY>" | gcloud secrets create lms-supabase-service-role-key --data-file=-
printf '%s' "$(openssl rand -hex 32)"             | gcloud secrets create lms-cron-secret --data-file=-
printf '%s' "$(openssl rand -hex 32)"             | gcloud secrets create lms-impersonation-secret --data-file=-

PN=$(gcloud projects describe "$(gcloud config get-value project)" --format='value(projectNumber)')
for s in lms-supabase-service-role-key lms-cron-secret lms-impersonation-secret; do
  gcloud secrets add-iam-policy-binding "$s" \
    --member="serviceAccount:${PN}-compute@developer.gserviceaccount.com" \
    --role="roles/secretmanager.secretAccessor"
done
```

Check the service-role key really is the staging one: it is a long JWT whose
decoded `ref` is `zeaclbapadosqqttexxh`. The deploy script refuses the
production project URL unless explicitly overridden.

### The platform sender's secrets (ADR 0029, optional until it is set up)

The platform's own mailbox (`lib/email/platform-sender.ts`): codes and
sign-in links for platform owners and organisation administrators,
administrator welcomes and SMTP alerts. It never sends a learner's mail and
is never a fallback for a tenant's SMTP. Every setting is a secret, the
non-secret ones too, so no address sits in the repository. Staging uses
its **own** mailbox credential, never production's, and an allow-list of
**exact addresses only**: `<local>@<domain>` entries cut at commas, each
allowing that one address (a "+tag" or a dot variant is another address and
is listed by itself), with no domain entry and no `*`. Staging's four entries
and what each serves are in `ops/RUNBOOK.md` §6.3a, "The allow-list"; the
real addresses are entered in the secret and nowhere else. Reserved test domains
(`.test`, `example.com` and the like) are never mailed, whatever the list
holds. A list with no usable entry sends nothing and reads as not configured.

```bash
printf '%s' "<smtp host>"                    | gcloud secrets create lms-platform-smtp-host --data-file=-
printf '%s' "465"                            | gcloud secrets create lms-platform-smtp-port --data-file=-
printf '%s' "true"                           | gcloud secrets create lms-platform-smtp-secure --data-file=-
printf '%s' "<mailbox sign-in name>"         | gcloud secrets create lms-platform-smtp-user --data-file=-
# the app password at a hidden prompt, so it is in no shell history
read -rs PW && printf '%s' "$PW" | gcloud secrets create lms-platform-smtp-password --data-file=-; unset PW
printf '%s' "<Name <address>>"               | gcloud secrets create lms-platform-smtp-from --data-file=-
# the allow-list at a hidden prompt too, so no file or shell history holds
# the addresses; its form: <local>@<domain>,<local>+<fixed-alias>@<domain>,...
read -rs AL && printf '%s' "$AL" | gcloud secrets create lms-platform-email-allow-domains --data-file=-; unset AL
# optional: lms-platform-email-reply-to, lms-platform-email-daily-ceiling
# (default 375; 25 where staging shares production's mailbox),
# lms-platform-email-org-daily-limit (default 50)

PN=$(gcloud projects describe "$(gcloud config get-value project)" --format='value(projectNumber)')
# every one the deploy script may mount; an optional one not created is skipped
for s in lms-platform-smtp-host lms-platform-smtp-port lms-platform-smtp-secure \
         lms-platform-smtp-user lms-platform-smtp-password lms-platform-smtp-from \
         lms-platform-email-allow-domains lms-platform-email-reply-to \
         lms-platform-email-daily-ceiling lms-platform-email-org-daily-limit; do
  gcloud secrets describe "$s" >/dev/null 2>&1 || continue
  gcloud secrets add-iam-policy-binding "$s" \
    --member="serviceAccount:${PN}-compute@developer.gserviceaccount.com" \
    --role="roles/secretmanager.secretAccessor"
done
```

`scripts/cloud-run-deploy.sh` mounts each of these that exists in Secret
Manager, on every deploy, and prints the names it mounted (never a value);
one that does not exist is left out, so a deploy before this setup still
succeeds. A secret it mounts must carry the runtime's `secretAccessor`
binding, or the deploy fails: run the loop above again after creating an
optional one later. Until the six required ones (host, port, user, password, From and
the allow-list) are mounted, the sender sends nothing and `/api/ops/health`
reads `degraded` to a caller with the secret (`platform_email` under
`email_checks`). `PLATFORM_EMAIL_SECRETS=0 ./scripts/cloud-run-deploy.sh`
mounts none of them. Rotation: add a new version of
`lms-platform-smtp-password` (`read -rs PW && printf '%s' "$PW" | gcloud
secrets versions add lms-platform-smtp-password --data-file=-; unset PW`),
redeploy, then press "Send test" on `/super/email`. A new allow-list: add
a version the same way (`read -rs AL && printf '%s' "$AL" | gcloud secrets
versions add lms-platform-email-allow-domains --data-file=-; unset AL`). The
script mounts the newest version, so every instance that starts afterwards
and the next deploy read it; then press "Send test". The ceiling: set
`lms-platform-email-daily-ceiling` to three quarters of the mailbox's daily
cap; without it the sender uses 375, three quarters of a personal Google
mailbox's cap (about 500 a day). Where staging's credential belongs to the
same mailbox as production's, staging's ceiling is 25.
Migration `0113_platform_email_log.sql` goes on the staging database before
the code (ADR 0029 decision 7). Details: `ops/RUNBOOK.md` §6.3.

## 3. Build and deploy (first time ≈ 8 min, later ≈ 5 min)

```bash
git clone https://github.com/technotalkad-web/LMS.git && cd LMS
# until the branch is merged:
git checkout feat/cloud-run-staging

cat > .env.cloudrun <<'EOF'
export NEXT_PUBLIC_SUPABASE_URL="https://zeaclbapadosqqttexxh.supabase.co"
export NEXT_PUBLIC_SUPABASE_ANON_KEY="<staging anon key — wrangler.toml [vars] NEXT_PUBLIC_SUPABASE_ANON_KEY>"
EOF
source .env.cloudrun
chmod +x scripts/cloud-run-deploy.sh
./scripts/cloud-run-deploy.sh
```

The script builds the image with Cloud Build, deploys it, and prints the
service URL, which it already knew in advance (Cloud Run URLs are
deterministic: `https://my-lms-staging-<project number>.asia-south1.run.app`),
so the URL inlined into the build is the real one and one build is enough.

Later deploys after code changes: `git pull` then the same command.
`MIN_INSTANCES=1 ./scripts/cloud-run-deploy.sh` removes cold starts
(roughly $8–15/month from credits) — leave it at 0 until real users arrive.

ALDS P4 flag (2026-10-19; ADR 0005 note (h) and its addition of that date):
`ALDS_P4=on ./scripts/cloud-run-deploy.sh` switches P4 on for this staging
service, only after `0100_alds_core.sql` is confirmed on the staging
database. `--set-env-vars` replaces the whole list on every deploy, so the
"on" state lives in whatever runs the deploy: the owner's launcher (outside
this repository; it deploys `origin/main` to staging only) carries
`export ALDS_P4=on` from the P4 staging sitting on. A deploy without it, or
a regenerated launcher that lacks the line, switches P4 off on Cloud Run
while the Workers staging keeps it on (`wrangler.toml` top-level `[vars]`).
The script refuses `ALDS_P4` when `NEXT_PUBLIC_SUPABASE_URL` is the
production project, even with `ALLOW_PROD=1`.

## 4. Make sign-in work on the new URL (2 min)

Supabase dashboard → **staging** project → Authentication → URL
Configuration → *Redirect URLs* → add:

```
https://my-lms-staging-<project number>.asia-south1.run.app/auth/callback
https://my-lms-staging-<project number>.asia-south1.run.app/auth/finish
```

Password sign-in works without this; magic links, invitations and Google
sign-in need it. (Google/SSO also need the URL in the provider's authorised
redirect list, only if those flows are tested here.)

## 5. Verify

```bash
URL=$(gcloud run services describe my-lms-staging --region asia-south1 --format='value(status.url)')
curl -s $URL/api/xapi/about                                   # {"version":["1.0.3",…]}
curl -s -o /dev/null -w "%{http_code}\n" $URL/qa-scoring/login # 200
```

Then in a browser: sign in with a staging account, open the dashboard, the
users page, launch a module, and check no page returns an error. Logs:
`gcloud run services logs read my-lms-staging --region asia-south1 --limit 100`.

**Deliberately not done in this phase:** repointing the GitHub e2e secret
or the scheduled crons (they keep using the Cloudflare staging worker), a
custom domain, and any production connection.

## 6. Later phases (when decided)

- **Custom domain before real users:** Cloud Run → Domain mappings (or a
  load balancer) for the chosen subdomain; add the same URL to Supabase
  redirect URLs and any OAuth provider. With the domain in place, moving
  back to Cloudflare is a DNS change and users notice nothing.
- **Continuous deploy:** a Cloud Build trigger on pushes to `main` running
  `cloudbuild.yaml` then `gcloud run deploy`, mirroring the staging deploy.
- **Crons and CI:** point the scheduled workflows and the
  `STAGING_NEXT_PUBLIC_SITE_URL` secret at the Cloud Run URL — one host only,
  never both, so reminder emails are not sent twice.

## 7. Cost and clean-up

Cloud Run's always-free tier covers 2 million requests and 180k vCPU-seconds
a month; a staging environment with `MIN_INSTANCES=0` normally stays inside
it. Cloud Build gives 120 free build-minutes a day. To remove everything:

```bash
gcloud run services delete my-lms-staging --region asia-south1
gcloud artifacts repositories delete lms --location asia-south1
gcloud projects delete "$PROJECT_ID"      # or keep the project and just delete the service
```

## Going back to Cloudflare

Upgrade the mentora account to Workers Paid, then **redeploy** the worker (a
worker deployed on the free plan keeps the 10 ms cap until redeployed), and
point the domain / URLs back at `my-lms.mentora.workers.dev`. Nothing in
Supabase changes.

# Cloud Run trial staging (Google Cloud credits)

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

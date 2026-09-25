# Temporary staging on Google Cloud Run

Why this exists: the Cloudflare Workers **free** plan caps every request at
10 ms of CPU. Server-rendered pages routinely need more, so staging throws
Cloudflare error 1102 ("Worker exceeded CPU time limit") at random. The
cheapest permanent fix is the Workers Paid plan ($5/month, 30 s CPU). This
runbook is the alternative while there is no Cloudflare budget: the same
code, built as a plain Node server, on Cloud Run paid from Google Cloud
credits. Cloud Run has no per-request CPU cap and memory is configurable.

Production stays on Cloudflare. Nothing here changes the Cloudflare build:
`next.config.ts` only switches to `output: "standalone"` when
`NEXT_OUTPUT=standalone`, which the Dockerfile sets.

What behaves differently on Cloud Run (all designed to degrade safely):

| Feature | On Workers | On Cloud Run |
| --- | --- | --- |
| Course content delivery | streamed + Cloudflare edge cache | streamed from Supabase storage / R2, no edge cache |
| External LRS forward | immediate (`waitUntil`) + 5-min cron | 5-min cron only (`/api/cron/lrs-forward`) |
| Cold start | none | 2–5 s after idle when `min-instances=0` |
| Custom tenant domains (CF SaaS) | supported | not available (staging only) |

Files: `Dockerfile`, `.dockerignore`, `cloudbuild.yaml`,
`scripts/cloud-run-deploy.sh`.

## 1. One-off project setup (10 minutes)

Install the [gcloud CLI](https://cloud.google.com/sdk/docs/install) (or use
Cloud Shell in the console, which has it), then:

```bash
gcloud auth login
gcloud config set project <YOUR_PROJECT_ID>
gcloud services enable run.googleapis.com cloudbuild.googleapis.com \
  artifactregistry.googleapis.com secretmanager.googleapis.com
gcloud artifacts repositories create lms --repository-format=docker \
  --location=asia-south1 --description="LMS images"
```

`asia-south1` is Mumbai. Keep the region close to the Supabase project.

## 2. Secrets (never in files or build args)

Take the values from the staging Worker's secrets (Cloudflare dashboard →
my-lms → Settings → Variables and Secrets) or from `.env.local`:

```bash
printf '%s' "<SUPABASE_SERVICE_ROLE_KEY>" | gcloud secrets create lms-supabase-service-role-key --data-file=-
printf '%s' "<CRON_SECRET>"               | gcloud secrets create lms-cron-secret --data-file=-
printf '%s' "<IMPERSONATION_SECRET>"      | gcloud secrets create lms-impersonation-secret --data-file=-
# optional, only if the auth-email fallback is wanted on this environment:
printf '%s' "<RESEND_API_KEY>"            | gcloud secrets create lms-resend-api-key --data-file=-
```

Grant the Cloud Run runtime service account access (default compute SA):

```bash
PN=$(gcloud projects describe $(gcloud config get-value project) --format='value(projectNumber)')
for s in lms-supabase-service-role-key lms-cron-secret lms-impersonation-secret lms-resend-api-key; do
  gcloud secrets add-iam-policy-binding $s \
    --member="serviceAccount:${PN}-compute@developer.gserviceaccount.com" \
    --role="roles/secretmanager.secretAccessor" 2>/dev/null || true
done
```

## 3. Build and deploy

```bash
export NEXT_PUBLIC_SUPABASE_URL="https://zeaclbapadosqqttexxh.supabase.co"   # staging
export NEXT_PUBLIC_SUPABASE_ANON_KEY="<staging anon key>"
export NEXT_PUBLIC_SITE_URL="https://my-lms-staging-PLACEHOLDER.a.run.app"  # first run only
./scripts/cloud-run-deploy.sh
```

The script prints the real service URL. Because `NEXT_PUBLIC_SITE_URL` is
inlined at build time (it drives auth redirects and the xAPI endpoint the
content packages call), run it once more with the real URL:

```bash
export NEXT_PUBLIC_SITE_URL="https://my-lms-staging-xxxxx-el.a.run.app"
./scripts/cloud-run-deploy.sh
```

Later deploys: the same command. `RESEND_SECRET=1` adds the Resend secret,
`MIN_INSTANCES=1` removes cold starts (roughly $8–15/month against credits).

## 4. Point the rest of the platform at it

1. **Supabase Auth** → URL configuration → add the Cloud Run URL to the
   redirect allow-list (`<url>/auth/callback`, `<url>/auth/finish`).
2. **GitHub secrets** (repo → Settings → Secrets): set
   `STAGING_NEXT_PUBLIC_SITE_URL` to the Cloud Run URL so the PR e2e suite
   and nightly e2e test this environment.
3. **Crons**: the scheduled workflows call `<site>/api/cron/*` with the cron
   secret; point their staging endpoint at the Cloud Run URL (the workflow
   has an `endpoint` input / secret for this).
4. **Google / SSO sign-in**: add the Cloud Run URL to the provider's
   authorised redirect URIs if those flows are to be tested here.

## 5. Verify

```bash
URL=https://my-lms-staging-xxxxx-el.a.run.app
curl -s $URL/api/xapi/about            # {"version":["1.0.3",…]}
curl -s -o /dev/null -w "%{http_code}\n" $URL/ambak/login   # 200
E2E_BASE_URL=$URL npx playwright test --reporter=list       # curated suite
```

Logs: `gcloud run services logs read my-lms-staging --region asia-south1`.

## 6. Cost and clean-up

Cloud Run's always-free tier covers 2 million requests and 180k vCPU-seconds
a month; a staging environment with `min-instances=0` normally stays inside
it, and `min-instances=1` costs on the order of $8–15/month, both paid from
the trial credits. Cloud Build charges per build minute (first 120 min/day
free). To remove everything:

```bash
gcloud run services delete my-lms-staging --region asia-south1
gcloud artifacts repositories delete lms --location asia-south1
gcloud secrets delete lms-supabase-service-role-key   # and the others
```

## Going back to Cloudflare

Upgrade the mentora account to Workers Paid, then **redeploy** the worker
(a worker deployed on the free plan keeps the 10 ms cap until redeployed),
and revert the GitHub / Supabase URLs above to `my-lms.mentora.workers.dev`.

#!/usr/bin/env bash
# Build + deploy the LMS to Cloud Run (trial staging on Google Cloud).
# Runbook: docs/CLOUD_RUN_STAGING.md. Run from the repo root in Cloud Shell
# (recommended), Git Bash or WSL after `gcloud auth login` and
# `gcloud config set project <trial project>`.
#
#   ./scripts/cloud-run-deploy.sh            # build + deploy
#   ./scripts/cloud-run-deploy.sh deploy     # redeploy the last built image
#
# Required env (see runbook §3 — put them in .env.cloudrun and `source` it):
#   NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY   (STAGING Supabase)
# Optional:
#   NEXT_PUBLIC_SITE_URL   defaults to the service's deterministic Cloud Run URL
#   REGION (asia-south1) SERVICE (my-lms-staging) MIN_INSTANCES (0) MAX_INSTANCES (3)
#   RESEND_SECRET=1        also mount lms-resend-api-key
#   ALLOW_PROD=1           required to point at the PRODUCTION Supabase project
# Secrets must already exist in Secret Manager (runbook §2):
#   lms-supabase-service-role-key, lms-cron-secret, lms-impersonation-secret
set -euo pipefail

REGION="${REGION:-asia-south1}"
REPO="${REPO:-lms}"
SERVICE="${SERVICE:-my-lms-staging}"
MODE="${1:-all}"
PROJECT="$(gcloud config get-value project 2>/dev/null)"
[[ -n "$PROJECT" ]] || { echo "✖ no gcloud project set — run: gcloud config set project <PROJECT_ID>"; exit 1; }
PROJECT_NUMBER="$(gcloud projects describe "$PROJECT" --format='value(projectNumber)')"
IMAGE="${REGION}-docker.pkg.dev/${PROJECT}/${REPO}/${SERVICE}:latest"

: "${NEXT_PUBLIC_SUPABASE_URL:?set NEXT_PUBLIC_SUPABASE_URL (staging Supabase project URL)}"
: "${NEXT_PUBLIC_SUPABASE_ANON_KEY:?set NEXT_PUBLIC_SUPABASE_ANON_KEY (staging anon key)}"

# Safety: the trial must not touch production data.
if [[ "$NEXT_PUBLIC_SUPABASE_URL" == *"alkfrcglmseksweqhwzq"* && "${ALLOW_PROD:-0}" != "1" ]]; then
  echo "✖ NEXT_PUBLIC_SUPABASE_URL points at the PRODUCTION Supabase project. Refusing (set ALLOW_PROD=1 to override)."
  exit 1
fi

# Cloud Run service URLs are deterministic, so the site URL (inlined into the
# build for auth redirects + xAPI endpoints) is known before the first deploy.
NEXT_PUBLIC_SITE_URL="${NEXT_PUBLIC_SITE_URL:-https://${SERVICE}-${PROJECT_NUMBER}.${REGION}.run.app}"
echo "▶ project ${PROJECT} (${PROJECT_NUMBER})  service ${SERVICE}  site ${NEXT_PUBLIC_SITE_URL}"

if [[ "$MODE" == "all" ]]; then
  echo "▶ building ${IMAGE} with Cloud Build"
  gcloud builds submit --config cloudbuild.yaml \
    --substitutions="_REGION=${REGION},_REPO=${REPO},_IMAGE=${SERVICE},_SUPABASE_URL=${NEXT_PUBLIC_SUPABASE_URL},_SUPABASE_ANON_KEY=${NEXT_PUBLIC_SUPABASE_ANON_KEY},_SITE_URL=${NEXT_PUBLIC_SITE_URL},_SENTRY_DSN=${NEXT_PUBLIC_SENTRY_DSN:-},_SENTRY_ENV=${NEXT_PUBLIC_SENTRY_ENV:-staging-gcp}"
fi

echo "▶ deploying ${SERVICE} to Cloud Run (${REGION})"
gcloud run deploy "${SERVICE}" \
  --image "${IMAGE}" \
  --region "${REGION}" \
  --platform managed \
  --allow-unauthenticated \
  --port 8080 \
  --cpu 1 --memory 1Gi \
  --concurrency 40 \
  --timeout 300 \
  --min-instances "${MIN_INSTANCES:-0}" --max-instances "${MAX_INSTANCES:-3}" \
  --set-env-vars "NODE_ENV=production,NEXT_PUBLIC_SUPABASE_URL=${NEXT_PUBLIC_SUPABASE_URL},NEXT_PUBLIC_SUPABASE_ANON_KEY=${NEXT_PUBLIC_SUPABASE_ANON_KEY},NEXT_PUBLIC_SITE_URL=${NEXT_PUBLIC_SITE_URL},NEXT_PUBLIC_SENTRY_ENV=${NEXT_PUBLIC_SENTRY_ENV:-staging-gcp},STORAGE_DRIVER=${STORAGE_DRIVER:-supabase},SUPABASE_STORAGE_BUCKET=${SUPABASE_STORAGE_BUCKET:-course-content},OPS_EXPECT_CRONS=${OPS_EXPECT_CRONS:-0}" \
  --set-secrets "SUPABASE_SERVICE_ROLE_KEY=lms-supabase-service-role-key:latest,CRON_SECRET=lms-cron-secret:latest,IMPERSONATION_SECRET=lms-impersonation-secret:latest${RESEND_SECRET:+,RESEND_API_KEY=lms-resend-api-key:latest}"

URL="$(gcloud run services describe "${SERVICE}" --region "${REGION}" --format='value(status.url)')"
echo "✓ ${SERVICE} is live at ${URL}"
if [[ "${NEXT_PUBLIC_SITE_URL}" != "${URL}" ]]; then
  echo "! The build was made for ${NEXT_PUBLIC_SITE_URL} but the service answers at ${URL}."
  echo "  Re-run with NEXT_PUBLIC_SITE_URL=${URL} so auth redirects and xAPI endpoints match."
fi
echo "  Next: add ${URL}/auth/callback and ${URL}/auth/finish to Supabase → Authentication → URL Configuration."

#!/usr/bin/env bash
# Build + deploy the LMS to Cloud Run (temporary staging on Google Cloud).
# Runbook: docs/CLOUD_RUN_STAGING.md. Run from the repo root in Git Bash,
# WSL or Cloud Shell after `gcloud auth login` and `gcloud config set project`.
#
#   ./scripts/cloud-run-deploy.sh            # build + deploy
#   ./scripts/cloud-run-deploy.sh deploy     # deploy the last built image only
#
# Required env (export before running, or put in .env.cloudrun and source it):
#   NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY   (staging Supabase)
#   NEXT_PUBLIC_SITE_URL   the Cloud Run URL once known (first deploy: any URL,
#                          then redeploy with the real one — it is inlined)
# Secrets must already exist in Secret Manager (see runbook §3):
#   lms-supabase-service-role-key, lms-cron-secret, lms-impersonation-secret,
#   lms-resend-api-key (optional)
set -euo pipefail

REGION="${REGION:-asia-south1}"
REPO="${REPO:-lms}"
SERVICE="${SERVICE:-my-lms-staging}"
PROJECT="$(gcloud config get-value project 2>/dev/null)"
IMAGE="${REGION}-docker.pkg.dev/${PROJECT}/${REPO}/${SERVICE}:latest"
MODE="${1:-all}"

: "${NEXT_PUBLIC_SUPABASE_URL:?set NEXT_PUBLIC_SUPABASE_URL}"
: "${NEXT_PUBLIC_SUPABASE_ANON_KEY:?set NEXT_PUBLIC_SUPABASE_ANON_KEY}"
: "${NEXT_PUBLIC_SITE_URL:?set NEXT_PUBLIC_SITE_URL}"

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
  echo "! NEXT_PUBLIC_SITE_URL (${NEXT_PUBLIC_SITE_URL}) differs from the service URL."
  echo "  Re-run with NEXT_PUBLIC_SITE_URL=${URL} so links, xAPI endpoints and auth redirects use it."
fi

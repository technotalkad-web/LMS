#!/usr/bin/env bash
# PR e2e in the runner (owner decision 2026-10-20, Option A). Builds THIS
# checkout, starts it on a local port against the STAGING Supabase project and
# runs the core e2e suite (tests/e2e) against it. Run by the "e2e (playwright)"
# job of .github/workflows/pr-checks.yml; the same command reproduces a CI run
# on a laptop (Git Bash or Linux):
#
#   CI=1 NEXT_PUBLIC_SUPABASE_URL=… NEXT_PUBLIC_SUPABASE_ANON_KEY=… \
#   SUPABASE_SERVICE_ROLE_KEY=… bash scripts/e2e-in-runner.sh [playwright args]
#
# On a laptop: stop any `next dev` in this checkout and move .env.local and
# .env.test.local aside first. `next build` rewrites the .next folder a running
# dev server uses; `next build`/`next start` read .env.local, whose extra
# secrets would make the run differ from CI (they cannot replace the three
# Supabase values checked below: Next.js never overrides a variable that is
# already set). .env.test.local is refused outright: playwright.config.ts loads
# it with override: true, so the Playwright process (global setup, purge and
# test helpers) would use whatever Supabase project it names instead of the
# one this script checked. Neither file exists in CI (both are gitignored).
#
# Why not the deployed Workers staging site: on the Cloudflare free plan it
# fails requests at random with error 1102 (CPU limit), which made the PR e2e
# red on 2026-10-20 for reasons unrelated to the PR; and it ran whatever
# staging last deployed, not the PR's code.
#
# Env:
#   NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY,
#   SUPABASE_SERVICE_ROLE_KEY   staging values (the STAGING_* secrets in CI);
#                               refused unless the URL is the staging project
#   E2E_PORT                    default 3100 (3001 is the hand-run dev server)
#   E2E_OUT                     where the build and server logs go
#                               (default $RUNNER_TEMP/e2e-in-runner)
#
# App configuration: the staging Worker's (wrangler.toml top-level [vars]):
# STORAGE_DRIVER=supabase, SUPABASE_STORAGE_BUCKET=course-content and
# ALDS_P4=on. The production configuration (ALDS_P4 absent) stays covered by
# the scheduled lifecycle nightly, which builds without the flag.
# IMPERSONATION_SECRET and CRON_SECRET are fresh random values for each run,
# masked in the GitHub log before use; no deployed secret is used.
#
# Public-log rule (the repository is public): the build log and the server log
# stay in E2E_OUT and are never printed or uploaded (server logs carry emails
# and request details). A build or server-start failure prints at most 40
# matching lines of its log with emails and tokens masked, as
# scripts/lifecycle-nightly.sh does. The Playwright list reporter prints to the
# job log as the job did before this change.
#
# Exit code: Playwright's. A build or start failure exits 1; bad input
# (including a .env.test.local in the checkout) exits 2.
set -euo pipefail

PORT="${E2E_PORT:-3100}"
OUT="${E2E_OUT:-${RUNNER_TEMP:-$(mktemp -d)}/e2e-in-runner}"
STAGING_REF="zeaclbapadosqqttexxh"

cd "$(dirname "$0")/.."

# playwright.config.ts loads .env.test.local with override: true, which would
# send the Playwright side of the run to whatever Supabase project that file
# names, past the staging check below. Refuse rather than run split-brained.
if [[ -e .env.test.local ]]; then
  echo "e2e-in-runner: refused, .env.test.local exists in this checkout; move it aside (playwright.config.ts would let it override the checked staging values)"
  exit 2
fi

mkdir -p "$OUT"

# Masks emails, JWTs and Supabase API keys in a log excerpt (GitHub also
# masks the secret values themselves).
redact() {
  sed -E \
    -e 's/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/<email>/g' \
    -e 's/eyJ[A-Za-z0-9._-]{10,}/<jwt>/g' \
    -e 's/sb_(secret|publishable)_[A-Za-z0-9_-]+/sb_\1_<masked>/g'
}

# At most 40 error lines of a log, masked.
error_excerpt() {
  { grep -E -A3 'Error|error TS|Failed|failed to|Module not found|Cannot find|EADDRINUSE|ERR_' "$1" 2>/dev/null || true; } \
    | head -n 40 | redact
}

for v in NEXT_PUBLIC_SUPABASE_URL NEXT_PUBLIC_SUPABASE_ANON_KEY SUPABASE_SERVICE_ROLE_KEY; do
  [[ -n "${!v:-}" ]] || { echo "e2e-in-runner: $v is not set"; exit 2; }
done
[[ "$PORT" =~ ^[0-9]{2,5}$ ]] || { echo "e2e-in-runner: E2E_PORT must be a number"; exit 2; }

# Staging only, before anything is built (the e2e global setup checks again).
if ! node -e '
  const u = new URL(process.env.NEXT_PUBLIC_SUPABASE_URL);
  process.exit(u.protocol === "https:" && u.hostname === process.argv[1] + ".supabase.co" && u.port === "" ? 0 : 1);
' "$STAGING_REF" 2>/dev/null; then
  echo "e2e-in-runner: refused, NEXT_PUBLIC_SUPABASE_URL is not the staging project ($STAGING_REF)"
  exit 2
fi

BASE="http://localhost:$PORT"

# Something already answering on the port would be tested instead of this
# build.
if curl -s -o /dev/null --max-time 5 "$BASE/login"; then
  echo "e2e-in-runner: refused, something already answers on $BASE"
  exit 2
fi

# Fresh per-run server secrets, always overwritten (never a deployed value).
rand_hex() { node -e 'process.stdout.write(require("crypto").randomBytes(32).toString("hex"))'; }
IMPERSONATION_SECRET="$(rand_hex)"
CRON_SECRET="$(rand_hex)"
if [[ "${GITHUB_ACTIONS:-}" == "true" ]]; then
  echo "::add-mask::$IMPERSONATION_SECRET"
  echo "::add-mask::$CRON_SECRET"
fi
export IMPERSONATION_SECRET CRON_SECRET

export NEXT_TELEMETRY_DISABLED=1
export NEXT_PUBLIC_SITE_URL="$BASE"
export STORAGE_DRIVER="supabase"
export SUPABASE_STORAGE_BUCKET="course-content"
export ALDS_P4="on"
# Playwright tests this server and does not start its own (playwright.config.ts).
export E2E_BASE_URL="$BASE"
export E2E_EXTERNAL_SERVER=1

echo "e2e-in-runner: building (log kept off the console)"
if ! npm run build > "$OUT/build.log" 2>&1; then
  echo "::error title=e2e::the app build failed"
  echo "e2e-in-runner: build failed; error lines of the build log (masked):"
  error_excerpt "$OUT/build.log"
  echo "e2e-in-runner: reproduce locally with this script"
  exit 1
fi

echo "e2e-in-runner: starting the app on port $PORT (log kept off the console)"
node node_modules/next/dist/bin/next start -p "$PORT" > "$OUT/server.log" 2>&1 &
SERVER_PID=$!
stop_server() { kill "$SERVER_PID" 2>/dev/null || true; wait "$SERVER_PID" 2>/dev/null || true; }
trap stop_server EXIT

up=0
code=""
for _ in $(seq 1 60); do
  code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "$BASE/login" || true)"
  if [[ "$code" == "200" ]]; then up=1; break; fi
  kill -0 "$SERVER_PID" 2>/dev/null || break
  sleep 2
done
if [[ "$up" != "1" ]]; then
  echo "::error title=e2e::the app did not start"
  echo "e2e-in-runner: the app did not answer /login with 200 within 120 s (last status ${code:-none}); error lines of the server log (masked):"
  error_excerpt "$OUT/server.log"
  exit 1
fi

echo "e2e-in-runner: running the e2e suite against $BASE"
set +e
npx playwright test --reporter=list "$@"
pw=$?
set -e
echo "e2e-in-runner: playwright exit $pw"
exit "$pw"

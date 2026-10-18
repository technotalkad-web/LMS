#!/usr/bin/env bash
# Lifecycle nightly (ADR 0007 step 15; subset widened by ADR 0008 step 17 and
# ADR 0009 step 12). Builds THIS checkout, starts it on a local port against
# the STAGING Supabase project, runs the ALDS lifecycle subset against it and
# prints counts only. Run by .github/workflows/lifecycle-nightly.yml; the
# same command reproduces a nightly run on a laptop (Git Bash or Linux):
#
#   NEXT_PUBLIC_SUPABASE_URL=… NEXT_PUBLIC_SUPABASE_ANON_KEY=… \
#   SUPABASE_SERVICE_ROLE_KEY=… bash scripts/lifecycle-nightly.sh
#
# Env:
#   NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY,
#   SUPABASE_SERVICE_ROLE_KEY   staging values (the STAGING_* secrets in CI);
#                               refused unless the URL is the staging project
#   LIFECYCLE_PORT              default 3100 (3001 is the hand-run dev server)
#   LIFECYCLE_SPECS             spec numbers, default the ADR subset below
#   LIFECYCLE_OUT               where the logs and the JSON report go
#                               (default $RUNNER_TEMP/lifecycle-nightly)
#
# Public-log rule (the repository is public): the build log, the server log,
# the Playwright output and its JSON report stay in LIFECYCLE_OUT; they are
# never printed or uploaded. Spec failure messages embed response bodies and
# test emails. Only counts (scripts/lifecycle-summary.mjs) and the cleanup's
# count line reach stdout. Reproduce a failure locally with this script.
#
# The data it creates is in the lifecycle namespace (lifecycle-* orgs,
# @lifecycle.test users), which the e2e purge never matches; the lifecycle
# global setup deletes it after 48 h (tests/bot/lifecycle/cleanup.ts).
set -euo pipefail

DEFAULT_SPECS="00 32 33 34 43 47 48 49 50 51 52 53 54 55"
PORT="${LIFECYCLE_PORT:-3100}"
SPECS="${LIFECYCLE_SPECS:-$DEFAULT_SPECS}"
OUT="${LIFECYCLE_OUT:-${RUNNER_TEMP:-$(mktemp -d)}/lifecycle-nightly}"
STAGING_REF="zeaclbapadosqqttexxh"

cd "$(dirname "$0")/.."
mkdir -p "$OUT"

for v in NEXT_PUBLIC_SUPABASE_URL NEXT_PUBLIC_SUPABASE_ANON_KEY SUPABASE_SERVICE_ROLE_KEY; do
  [[ -n "${!v:-}" ]] || { echo "lifecycle-nightly: $v is not set"; exit 2; }
done
[[ "$PORT" =~ ^[0-9]{2,5}$ ]] || { echo "lifecycle-nightly: LIFECYCLE_PORT must be a number"; exit 2; }

# Staging only, before anything is built (the lifecycle setup checks again).
if ! node -e '
  const u = new URL(process.env.NEXT_PUBLIC_SUPABASE_URL);
  process.exit(u.protocol === "https:" && u.hostname === process.argv[1] + ".supabase.co" && u.port === "" ? 0 : 1);
' "$STAGING_REF" 2>/dev/null; then
  echo "lifecycle-nightly: refused, NEXT_PUBLIC_SUPABASE_URL is not the staging project ($STAGING_REF)"
  exit 2
fi

# Spec numbers → files; a renamed or missing spec fails the run.
FILES=()
for n in $SPECS; do
  [[ "$n" =~ ^[0-9]{2}$ ]] || { echo "lifecycle-nightly: bad spec number '$n'"; exit 2; }
  matches=(tests/bot/lifecycle/"$n"-*.spec.ts)
  if [[ ${#matches[@]} -ne 1 || ! -f "${matches[0]}" ]]; then
    echo "lifecycle-nightly: expected one tests/bot/lifecycle/$n-*.spec.ts, found ${#matches[@]}"
    exit 2
  fi
  FILES+=("${matches[0]}")
done

BASE="http://localhost:$PORT"
export NEXT_TELEMETRY_DISABLED=1
export NEXT_PUBLIC_SITE_URL="$BASE"
export E2E_BASE_URL="$BASE"

echo "lifecycle-nightly: building (log kept off the console)"
if ! npm run build > "$OUT/build.log" 2>&1; then
  echo "lifecycle-nightly: build failed; reproduce locally with this script"
  exit 1
fi

echo "lifecycle-nightly: starting the app on port $PORT"
node node_modules/next/dist/bin/next start -p "$PORT" > "$OUT/server.log" 2>&1 &
SERVER_PID=$!
stop_server() { kill "$SERVER_PID" 2>/dev/null || true; wait "$SERVER_PID" 2>/dev/null || true; }
trap stop_server EXIT

up=0
for _ in $(seq 1 60); do
  code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "$BASE/login" || true)"
  if [[ "$code" == "200" ]]; then up=1; break; fi
  kill -0 "$SERVER_PID" 2>/dev/null || break
  sleep 2
done
if [[ "$up" != "1" ]]; then
  echo "lifecycle-nightly: the app did not answer /login with 200 within 120 s"
  exit 1
fi

echo "lifecycle-nightly: running ${#FILES[@]} spec file(s): $SPECS"
set +e
LIFECYCLE_SERVER_LOG="$OUT/server.log" \
PLAYWRIGHT_JSON_OUTPUT_NAME="$OUT/results.json" \
  npx playwright test --config=playwright.lifecycle.config.ts --reporter=json "${FILES[@]}" \
  > "$OUT/playwright.log" 2>&1
pw=$?
set -e

# The cleanup's own line carries counts and error codes only.
grep -E '^\[lifecycle-cleanup\] ' "$OUT/playwright.log" || echo "lifecycle-nightly: no cleanup line (did the global setup run?)"

summary=0
node scripts/lifecycle-summary.mjs "$OUT/results.json" || summary=$?
echo "lifecycle-nightly: playwright exit $pw, summary exit $summary"
if [[ "$pw" -ne 0 || "$summary" -ne 0 ]]; then exit 1; fi

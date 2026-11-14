#!/usr/bin/env bash
# Lifecycle nightly (ADR 0007 step 15; subset widened by ADR 0008 step 17,
# ADR 0009 step 12, ADR 0019 decision 7, ADR 0020 step 10, ADR 0021 F.5 and
# ADR 0022 G item 18).
# Builds THIS checkout, starts it on a local port against
# the STAGING Supabase project, runs the ALDS lifecycle subset against it and
# prints counts and failing-test locations and durations only. Run by
# .github/workflows/lifecycle-nightly.yml; the same command reproduces a
# nightly run on a laptop (Git Bash or Linux):
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
#   LIFECYCLE_LIST              default | products (default "default"): which
#                               list runs. The workflow's first job runs
#                               DEFAULT_SPECS (or LIFECYCLE_SPECS when given);
#                               its second job runs PRODUCT_SPECS, and passes
#                               at once when that list is empty or when
#                               LIFECYCLE_SPECS is given (those run in the
#                               first job). ADR 0024 step 73: the nightly is
#                               split into two jobs that run one after the
#                               other before new specs join.
#   LIFECYCLE_PLAN_ONLY         when set: print the choice, write run=true or
#                               run=false to $GITHUB_OUTPUT, and stop before
#                               anything is built or run (the workflow's
#                               selection step; it needs no secrets)
#   LIFECYCLE_OUT               where the logs and the JSON report go
#                               (default $RUNNER_TEMP/lifecycle-nightly)
#
# On a laptop: stop any `next dev` in this checkout first. The script runs
# `next build`, which rewrites the .next folder a running dev server uses.
#
# Public-log rule (the repository is public): the build log, the server log,
# the Playwright output and its JSON report stay in LIFECYCLE_OUT; they are
# never uploaded. Spec failure messages embed response bodies and test
# emails, so the Playwright output is never printed: only the counts and,
# for each failing test, its title path, the file:line:column of its
# first error and how long it ran (scripts/lifecycle-summary.mjs; ADR 0007
# decision 2, notes of 2026-10-19 and 2026-11-14) and the cleanup's count
# line reach stdout.
# A build or server-start failure prints at most 40 matching lines of its
# log with emails and tokens masked (compiler and Node errors name files of
# this public repository, not data). Reproduce a failure locally with this
# script.
#
# The data it creates is in the lifecycle namespace (lifecycle-* orgs,
# @lifecycle.test users), which the e2e purge never matches; the lifecycle
# global setup deletes it after 48 h (tests/bot/lifecycle/cleanup.ts).
set -euo pipefail

DEFAULT_SPECS="00 32 33 34 43 47 48 49 50 51 52 53 54 55 63 64 65 66"
# The second job's list: the specs of ADR 0024 (68 onward) join here, each
# after one green run by hand on staging. A spec number is in one list only
# (tests/unit/lifecycle-nightly-lists.test.ts).
PRODUCT_SPECS=""
PORT="${LIFECYCLE_PORT:-3100}"
STAGING_REF="zeaclbapadosqqttexxh"

# Which list runs. Both early exits come before anything is built or run.
LIST="${LIFECYCLE_LIST:-default}"
GIVEN="${LIFECYCLE_SPECS:-}"
SKIP=""
case "$LIST" in
  default) SPECS="${GIVEN:-$DEFAULT_SPECS}" ;;
  products)
    if [[ -n "${GIVEN// /}" ]]; then
      SKIP="skipped: specs given (they run in the first job)"
    elif [[ -z "${PRODUCT_SPECS// /}" ]]; then
      SKIP="no product specs yet"
    else
      SPECS="$PRODUCT_SPECS"
    fi
    ;;
  *) echo "lifecycle-nightly: LIFECYCLE_LIST must be 'default' or 'products'"; exit 2 ;;
esac
if [[ -n "${LIFECYCLE_PLAN_ONLY:-}" ]]; then
  if [[ -n "$SKIP" ]]; then
    echo "lifecycle-nightly: $SKIP"
    run=false
  else
    echo "lifecycle-nightly: list '$LIST' will run: $SPECS"
    run=true
  fi
  if [[ -n "${GITHUB_OUTPUT:-}" ]]; then echo "run=$run" >> "$GITHUB_OUTPUT"; fi
  exit 0
fi
if [[ -n "$SKIP" ]]; then
  echo "lifecycle-nightly: $SKIP"
  exit 0
fi

OUT="${LIFECYCLE_OUT:-${RUNNER_TEMP:-$(mktemp -d)}/lifecycle-nightly}"

cd "$(dirname "$0")/.."
mkdir -p "$OUT"

# Masks emails, JWTs and Supabase API keys in a log excerpt (GitHub also
# masks the secret values themselves).
redact() {
  sed -E \
    -e 's/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/<email>/g' \
    -e 's/eyJ[A-Za-z0-9._-]{10,}/<jwt>/g' \
    -e 's/sb_(secret|publishable)_[A-Za-z0-9_-]+/sb_\1_<masked>/g'
}

# At most 40 error lines of a log, masked: enough to see which file or
# module broke without publishing the whole log.
error_excerpt() {
  { grep -E -A3 'Error|error TS|Failed|failed to|Module not found|Cannot find|EADDRINUSE|ERR_' "$1" 2>/dev/null || true; } \
    | head -n 40 | redact
}

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
# As scripts/e2e-in-runner.sh sets it, because the staging database has 0100.
# With the flag absent a staff launch stores is_preview false, 0100's delete
# guards count that row as learner history, and spec 50's admin delete answers
# 409: a pairing of flag and database that no deployment runs.
export ALDS_P4="on"

# A build that failed only because next/font could not fetch Google Fonts
# (an unparseable or missing answer from fonts.googleapis.com; seen three
# times on 2026-11-12 and 13, each passing on the next run) is retried ONCE,
# with a warning that stays on the run. Any other failure, and a second
# failure of any kind, is reported as before. Owner, 2026-11-13: "The retry
# must happen only once. Persistent errors and genuine code/build failures
# must still be reported normally and must not be hidden."
# Only the two final failures match: an error thrown from next/font's Google
# loader (its stack names the loader path) and its "Failed to fetch `X` from
# Google Fonts." Its own retry lines ("Failed to fetch font `X`: <url>
# Retrying 1/3...") are printed even when a later try succeeds, so they must
# not match: a build that recovered and then failed for a real reason is not
# retried.
FONT_FETCH_FAILURE='@next[/\]font[/\]dist[/\]google[/\]|Failed to fetch `[^`]+` from Google Fonts'
font_fetch_failure() { grep -E -q "$FONT_FETCH_FAILURE" "$1" 2>/dev/null; }
build_failed() {
  echo "::error title=Lifecycle nightly::the app build failed"
  echo "lifecycle-nightly: build failed; error lines of the build log (masked):"
  error_excerpt "$OUT/build.log"
  echo "lifecycle-nightly: reproduce locally with this script"
  exit 1
}

echo "lifecycle-nightly: building (log kept off the console)"
if ! npm run build > "$OUT/build.log" 2>&1; then
  if ! font_fetch_failure "$OUT/build.log"; then
    build_failed
  fi
  echo "::warning title=Lifecycle nightly::the app build failed fetching Google Fonts; retrying the build once"
  mv "$OUT/build.log" "$OUT/build-attempt-1.log"
  sleep 30
  echo "lifecycle-nightly: building again (the only retry)"
  if ! npm run build > "$OUT/build.log" 2>&1; then
    build_failed
  fi
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
  echo "::error title=Lifecycle nightly::the app did not start"
  echo "lifecycle-nightly: the app did not answer /login with 200 within 120 s (last status ${code:-none}); error lines of the server log (masked):"
  error_excerpt "$OUT/server.log"
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

# The cleanup's own line carries counts and error codes only. It does not
# decide the exit code (the specs do), but anything short of a clean sweep
# becomes a run annotation: a delete refused (the 0098 service-role
# exemption stopped matching, a new foreign key), a query error, a per-run
# bound reached, a thrown cleanup, or no line at all.
cleanup_line="$(grep -E '^\[lifecycle-cleanup\] ' "$OUT/playwright.log" | head -n 1 || true)"
if [[ -z "$cleanup_line" ]]; then
  echo "::warning title=Lifecycle cleanup::no cleanup line (the global setup did not run)"
else
  echo "$cleanup_line"
  if [[ "$cleanup_line" =~ failed=[1-9] || "$cleanup_line" == *"errors="* \
     || "$cleanup_line" == *"capped="* || "$cleanup_line" == "[lifecycle-cleanup] failed:"* ]]; then
    echo "::warning title=Lifecycle cleanup::the 48 h cleanup did not finish cleanly (see the cleanup line)"
  fi
fi

summary=0
node scripts/lifecycle-summary.mjs "$OUT/results.json" || summary=$?
echo "lifecycle-nightly: playwright exit $pw, summary exit $summary"
if [[ "$pw" -ne 0 || "$summary" -ne 0 ]]; then exit 1; fi

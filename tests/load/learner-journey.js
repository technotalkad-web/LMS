/**
 * k6 load test — realistic learner journey against the deployed staging app.
 *
 * Each VU is one seeded learner (see seed.mjs). On first iteration it signs in
 * via the Supabase password grant and forges the exact @supabase/ssr cookie set
 * (base64url session, chunked at 3180 chars) that the Next.js middleware
 * validates with auth.getUser(). Then it loops the real journey:
 *
 *   dashboard → course list → course launch (SSR find-or-create attempt)
 *   → SCORM commits (2 in-progress; 30% of sessions finish the course)
 *
 * Run (after `node tests/load/seed.mjs`):
 *   k6 run tests/load/learner-journey.js -e MODE=smoke   # 5 VUs, 90s
 *   k6 run tests/load/learner-journey.js -e MODE=load    # ramp 0→300 VUs, ~8m
 */
import http from "k6/http";
import { check, sleep, fail } from "k6";
import encoding from "k6/encoding";
import { Counter } from "k6/metrics";

const SEED = JSON.parse(open("./.seed.json"));
const BASE = SEED.baseUrl;
const PROJECT_REF = SEED.supabaseUrl.replace("https://", "").split(".")[0];
const COOKIE_NAME = `sb-${PROJECT_REF}-auth-token`;
const MODE = __ENV.MODE || "smoke";

const loginRetries = new Counter("login_retries");
const attemptParseFail = new Counter("attempt_parse_fail");

const SCENARIOS = {
  smoke: {
    journey: { executor: "constant-vus", vus: 5, duration: "90s" },
  },
  // Sustained plateau at TARGET VUs (default 40) — for locating the clean-
  // capacity knee between the smoke baseline and the saturating peak run.
  sustain: {
    journey: {
      executor: "ramping-vus",
      startVUs: 0,
      stages: [
        { duration: "1m", target: Number(__ENV.TARGET || 40) },
        { duration: "3m", target: Number(__ENV.TARGET || 40) },
        { duration: "30s", target: 0 },
      ],
      gracefulRampDown: "30s",
    },
  },
  // Realistic sustained peak for a 1,000-employee org (~10% concurrently active).
  peak: {
    journey: {
      executor: "ramping-vus",
      startVUs: 0,
      stages: [
        { duration: "2m", target: 100 },
        { duration: "4m", target: 100 },
        { duration: "30s", target: 0 },
      ],
      gracefulRampDown: "30s",
    },
  },
  // Stress: find the saturation point. Single-IP artifact warning: Supabase
  // rate-limits the auth endpoint per IP, so sign-in storms at high VU counts
  // cascade into failures real multi-IP traffic would not see.
  load: {
    journey: {
      executor: "ramping-vus",
      startVUs: 0,
      stages: [
        { duration: "2m", target: 100 },
        { duration: "2m", target: 200 },
        { duration: "3m", target: 300 },
        { duration: "1m", target: 0 },
      ],
      gracefulRampDown: "30s",
    },
  },
};

export const options = {
  scenarios: SCENARIOS[MODE],
  // k6 empties the per-VU cookie jar between iterations by default, which
  // would silently de-authenticate every iteration after the first.
  noCookiesReset: true,
  summaryTrendStats: ["avg", "med", "p(90)", "p(95)", "p(99)", "max"],
  thresholds: {
    http_req_failed: ["rate<0.01"],
    // Degradation gates: the 5-VU smoke baseline is ~1.5-2s p95 per page
    // (sequential SSR Supabase round-trips dominate; see results/smoke.json),
    // so these fail only if latency degrades under load, which is the
    // question a capacity test answers. Absolute-latency targets from
    // HANDOVER-READINESS §5 are tracked separately in the report.
    "http_req_duration{page:dashboard}": ["p(95)<3000"],
    "http_req_duration{page:courses}": ["p(95)<3000"],
    "http_req_duration{page:launch}": ["p(95)<3500"],
    "http_req_duration{page:commit}": ["p(95)<2500"],
    checks: ["rate>0.99"],
  },
};

// ---- auth -----------------------------------------------------------------
function learnerEmail(vu) {
  const i = ((vu - 1) % SEED.users) + 1;
  return `${SEED.emailPrefix}${String(i).padStart(4, "0")}@${SEED.emailDomain}`;
}

function signIn(email) {
  // Retry with backoff — all VUs share one IP, so the auth endpoint may 429.
  for (let attempt = 0; attempt < 6; attempt++) {
    const res = http.post(
      `${SEED.supabaseUrl}/auth/v1/token?grant_type=password`,
      JSON.stringify({ email, password: SEED.password }),
      {
        headers: { apikey: SEED.anonKey, "Content-Type": "application/json" },
        tags: { page: "auth" },
        // 429 = Supabase per-IP rate limit, an artifact of single-machine
        // testing; count it as a retry (login_retries), not a failed request.
        responseCallback: http.expectedStatuses(200, 429),
      }
    );
    if (res.status === 200) return res.json();
    loginRetries.add(1);
    sleep(2 * (attempt + 1) + Math.random() * 2);
  }
  fail(`sign-in failed for ${email}`);
}

function setSessionCookies(session) {
  const value = "base64-" + encoding.b64encode(JSON.stringify(session), "rawurl");
  const MAX = 3180;
  const jar = http.cookieJar();
  if (value.length <= MAX) {
    jar.set(BASE, COOKIE_NAME, value, { path: "/" });
    return;
  }
  for (let i = 0; i * MAX < value.length; i++) {
    jar.set(BASE, `${COOKIE_NAME}.${i}`, value.slice(i * MAX, (i + 1) * MAX), { path: "/" });
  }
}

let session = null; // per-VU

function ensureSignedIn() {
  const now = Date.now() / 1000;
  if (!session || now > session.expires_at - 120) {
    session = signIn(learnerEmail(__VU));
  }
  // Re-set every iteration — cheap, and immune to jar clearing.
  setSessionCookies(session);
}

// ---- journey --------------------------------------------------------------
const think = () => sleep(1 + Math.random() * 2);

export default function () {
  ensureSignedIn();

  const dash = http.get(`${BASE}/${SEED.orgSlug}/dashboard`, { tags: { page: "dashboard" } });
  check(dash, {
    "dashboard 200": (r) => r.status === 200,
    "dashboard authed (no login redirect)": (r) => !r.url.includes("/login"),
  });
  think();

  const list = http.get(`${BASE}/${SEED.orgSlug}/courses`, { tags: { page: "courses" } });
  check(list, { "courses 200": (r) => r.status === 200 });
  think();

  const launch = http.get(`${BASE}/${SEED.orgSlug}/courses/${SEED.courseId}/launch`, {
    tags: { page: "launch" },
  });
  const okLaunch = check(launch, { "launch 200": (r) => r.status === 200 });

  // attemptId is a prop of the client ScormRuntime component, so it is present
  // in the RSC flight payload (quotes may be backslash-escaped inside script chunks).
  const m = /attemptId\\?":\\?"([0-9a-f-]{36})/.exec(launch.body || "");
  if (!okLaunch || !m) {
    attemptParseFail.add(1);
    think();
    return;
  }
  const attemptId = m[1];
  think();

  const commit = (cmi, finished) =>
    http.post(
      `${BASE}/api/scorm/${attemptId}/commit`,
      JSON.stringify({ cmi, finished }),
      { headers: { "Content-Type": "application/json" }, tags: { page: "commit" } }
    );

  // Two mid-course saves, like a player bookmarking progress.
  for (let page = 1; page <= 2; page++) {
    const r = commit(
      {
        "cmi.core.lesson_status": "incomplete",
        "cmi.core.lesson_location": `page-${page}`,
        "cmi.suspend_data": `bookmark=page-${page};visited=${page}`,
      },
      false
    );
    check(r, { "commit 200": (x) => x.status === 200 });
    think();
  }

  // ~30% of sessions finish the course (keeps attempt-row growth realistic:
  // unfinished attempts are resumed by the next launch, not recreated).
  if (__ITER % 10 < 3) {
    const r = commit(
      { "cmi.core.lesson_status": "completed", "cmi.core.score.raw": "90" },
      true
    );
    check(r, { "final commit 200": (x) => x.status === 200 });
  }
  think();
}

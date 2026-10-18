# Load tests (k6)

Capacity/latency evidence for the learner journey against the deployed
**staging** app (`E2E_BASE_URL` in `.env.test.local`). Never point this at prod.

## Prereqs

- [k6](https://k6.io) installed (`winget install GrafanaLabs.k6`)
- `.env.test.local` with staging `E2E_BASE_URL`, Supabase URL + anon + service-role keys

## Usage

```bash
npm run load:seed          # one-time: qa-load org, 300 learners, SCORM course, org-wide assignment
npm run load:smoke         # 5 VUs / 90s — validates the script + captures a baseline
npm run load:test          # ramp 0→100→200→300 VUs over ~8m
npm run load:purge         # remove ONLY the qa-load org and qa+load-* users
```

`load:seed` writes `tests/load/.seed.json` (gitignored — contains test
credentials) which the k6 script reads. Pass `--users N` to seed a different
count; the k6 `load` scenario needs at least as many users as peak VUs.

No password is committed: each `load:seed` run sets every load user's password to
`LOAD_TEST_PASSWORD` if set, otherwise to a new random one, and records it only in
`.seed.json`. Seed again before a k6 run if `.seed.json` is missing.

## What the test does

Each VU is one seeded learner. It signs in through the real Supabase password
grant, builds the exact `@supabase/ssr` session cookie the Next.js middleware
validates (base64url, `base64-` prefix, chunked at 3180 chars), then loops with
1–3s think time:

1. `GET /qa-load/dashboard`
2. `GET /qa-load/courses`
3. `GET /qa-load/courses/{id}/launch` — SSR find-or-create of the attempt;
   the attempt id is parsed out of the RSC payload
4. `POST /api/scorm/{attemptId}/commit` ×2 (in-progress bookmarks)
5. 30% of sessions send a final `finished: true` commit (completion)

Unfinished attempts are resumed by the next launch, matching real learner
behaviour and keeping row growth realistic.

## Thresholds

`http_req_failed < 1%`, `checks > 99%`, and per-endpoint p95 gates set as
*degradation* limits relative to the 5-VU smoke baseline (~1.5–2s pages — the
absolute baseline is dominated by sequential SSR→Supabase round-trips, a
performance-tuning item tracked in docs/HANDOVER-READINESS.md §5, not a
capacity limit). A failed run means latency under load degraded vs. baseline
or errors appeared.

Results land in `tests/load/results/` (gitignored) via `--summary-export`.

## Findings — 2026-07-21 baseline run (staging, free-tier infra)

- Baseline (5 VUs): 100% success; pages p95 1.8–2.2 s, commit p95 1.7 s.
- Peak (100 VUs sustained) and stress (300 VUs): **writes held** (commit success
  ≥99.8%, p95 ≤2.25 s; page p50 stayed flat ~1.5–1.9 s) but the page tail
  collapsed to timeouts (~31–36% request failures).
- **Root cause captured: Cloudflare error 1102 ("Worker exceeded resource
  limits")** — staging runs on the Workers FREE plan (10 ms CPU/request). The
  paid plan (30 s CPU) plus a co-located production Supabase compute tier is the
  fix. Secondary: each SSR page makes several sequential cross-region Supabase
  round-trips (batching opportunity), and middleware validates sessions via a
  network `auth.getUser()` call per request (switch to local JWT verification).
- Single-IP caveat: Supabase auth rate-limits per IP; at 300 VUs sign-in storms
  amplified failures (1,946 retries) in a way real multi-IP traffic would not.
  Leave ≥10 min recovery between runs — back-to-back runs contaminate results
  (the Worker keeps flapping 503/1102 for several minutes after load stops).

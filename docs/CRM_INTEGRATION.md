# CRM / In-House Application Integration Guide

The LMS is designed to run as the **invisible learning engine behind your own
application** — a CRM, HR portal, or any internal tool. Employees never see a
second login screen or learn a second URL: your app is the front door, the LMS
does the learning. This document is the complete contract for the team
building the other half.

All endpoints live under `/api/integrations/*` on the LMS host
(production: `https://my-lms-prod.mentora.workers.dev`), authenticate with an
**org-scoped API key**, and are verified end-to-end by an automated
31-check harness on every change.

---

## 1. Architecture: front door, not iframe

**Pattern:** your app renders the learning UI natively (cards in your own
style, fed by the summary API) and hands the browser to the LMS only for the
actual learning moment, via a one-time signed link. The LMS renders
chrome-less ("embedded mode") with a single **Back to CRM** button, then
returns. Results flow back through a signed webhook.

**Why not an iframe:** modern browsers partition third-party cookies, so an
LMS session inside your app's iframe breaks randomly (Safari first), and a
SCORM player nested two iframes deep is fragile. The redirect-with-auto-login
pattern is what enterprise suites use: it *feels* like one app and works on
every browser and mobile WebView, because the LMS is always a top-level
navigation.

```
CRM backend ──PUT /employees──────────▶ LMS   (joiners / transfers / leavers)
CRM backend ──GET /learner-summary───▶ LMS   (data for your Learning cards)
CRM backend ──POST /sso-link─────────▶ LMS   (returns one-time login_url)
Browser     ──redirect to login_url──▶ LMS   (signed in, embedded, Back-to-CRM)
LMS         ──POST webhook (HMAC)────▶ CRM   (course completed → employee record)
```

## 2. Features & benefits

| Feature | What it does | Benefit |
| --- | --- | --- |
| **API keys** | Org-scoped machine credentials (`ambk_…`), sha256-stored, shown once, revocable, usage-stamped | No shared passwords, no service-role exposure; one click kills a leaked key |
| **SSO handoff** (`sso-link`) | One-time signed URL that lands an employee inside any module already signed in | Zero passwords, zero second app; works from CRM buttons *and* email deep links |
| **Embedded mode** | LMS hides all its own navigation behind a slim "Back to CRM" bar | The LMS reads as a screen of *your* app |
| **Learner summary** | One GET returns courses (status/score/due/overdue), path progress, journey day + behind-schedule, XP/streak | Your Learning cards render natively, always in agreement with the LMS |
| **Employee sync** | Upsert/deactivate by `employee_id`; governance-enforced; managers linked by their employee_id | CRM stays master of people — no manual CSV uploads, joiners learn on day one |
| **Completion webhook** | HMAC-signed POST the moment a course completes | Employee's CRM record updates in near-real-time, no polling |
| **Security guarantees** | Admin accounts refused for SSO *and* sync; roles can never be escalated; targets confined to the org | A compromised CRM key can never yield admin access |

## 3. Step-by-step integration

### Step 1 — Get an API key
LMS admin → **Configure → CRM & API** (Super Owner only) → *Create key*.
Copy the plaintext **once** and store it server-side in your app (secret
manager / env var). It never appears again; revoke + recreate to rotate.

Use it on every call:

```
Authorization: Bearer ambk_<hex>
```

Never ship the key to browser code. All calls below are backend-to-backend.

### Step 2 — Sync your employees

`PUT /api/integrations/employees` — upsert keyed by `employee_id`.

```json
{
  "employee_id": "AMB-1042",
  "email": "riya.sharma@ambak.com",
  "first_name": "Riya",
  "last_name": "Sharma",
  "designation": "Sales Advisor",
  "city": "Mumbai",
  "business_vertical": "Retail",
  "branch": "Andheri",
  "date_of_joining": "2026-09-01",
  "line_manager_employee_id": "AMB-0007"
}
```

Rules your sync can rely on:

- **Upsert = employed.** Same call for hire, transfer, promotion, and rehire
  (it re-activates a deactivated account). Partial updates touch only the
  fields you send.
- **`DELETE /api/integrations/employees`** with `{ "employee_id": "…" }` =
  leaver. Deactivates (learning history preserved); they instantly disappear
  from summary and SSO.
- **Master-data governance applies**: fields the Super Owner governs
  (designation, city, …) must use master values → `400` with the exact
  message admins see. Sync the master lists first or map values in the CRM.
- **Managers by employee_id**: `line_manager_employee_id` /
  `indirect_manager_employee_id`. Unresolvable references come back in a
  `warnings` array and are skipped — the sync never fails on ordering. Sync
  managers before their reports, or run a second reconciliation pass.
- **Email is identity**: required at create, immutable via sync (change it in
  the LMS admin if ever truly needed).
- Created accounts are always **learners** with **no password** — they will
  only ever enter through your SSO handoff.
- `GET /api/integrations/employees?employee_id=…` reads a record back for
  reconciliation.

### Step 3 — Render the Learning section

`GET /api/integrations/learner-summary?employee_id=AMB-1042`

```json
{
  "employee_id": "AMB-1042",
  "name": "Riya Sharma",
  "courses": [
    {
      "course_id": "…", "title": "Objection Handling",
      "status": "in_progress", "score": 82, "attempts": 2,
      "official_score": 82, "first_score": 74, "best_score": 82,
      "scored_attempts": 2, "practice_attempts": 0,
      "due_at": "2026-09-30T00:00:00+00:00", "overdue": false,
      "target": "/ambak/courses/…/launch"
    }
  ],
  "paths": [{ "name": "NHT HR", "steps_total": 3, "steps_completed": 2, "target": "/ambak/paths/…" }],
  "journeys": [{ "name": "30 Days Yoddha Journey", "day": 12, "days_total": 30, "behind_days": 1, "target": "/ambak/journey" }],
  "engagement": { "xp": 550, "streak_days": 4, "last_active": "2026-09-16" },
  "summary": { "assigned": 6, "completed": 4, "overdue": 0 }
}
```

Render these as native cards in your app. Statuses:
`not_started | in_progress | completed | passed`. Every item carries a
ready-made `target` for Step 4.

**Scores follow the LMS's attempt rules.** Admins configure, per module /
learning path / journey, how many completed attempts are scored (default 3)
and which one is the official score (default: the first attempt). `score`
and `official_score` are that official value; `first_score` is retained for
learning-gain analysis, `best_score` is the best inside the scored window,
and `practice_attempts` counts revision attempts beyond the window — those
never change any score. Show `official_score` on the employee's card. Entitlements (direct, org-wide, team, and
dynamic-group assignments) are expanded with the same resolvers the LMS
itself uses, so your card and the LMS always agree.

### Step 4 — One-click launch (SSO handoff)

When the employee clicks a card, your **backend** calls:

`POST /api/integrations/sso-link`

```json
{
  "employee_id": "AMB-1042",
  "target": "/ambak/courses/<course_id>/launch",
  "return_url": "https://crm.ambak.com/learning"
}
```

→ `{ "login_url": "https://…/auth/callback?token_hash=…", "expires_in": 3600 }`

Redirect the browser to `login_url`. The employee lands **inside the module,
already signed in**. Because `return_url` was provided, the LMS renders in
embedded mode: no LMS navigation, just a **← Back to CRM** button that
returns to your URL and ends embedded mode.

- Links are one-time; mint fresh per click, redirect immediately.
- `target` must be a path inside your org (`/ambak/…`); omit it to land on
  the dashboard. `return_url` must be https.
- **Admin accounts are refused (403)** — by design, the integration can only
  ever sign in learners.
- Works identically in a mobile app's browser view (top-level navigation, no
  cookie issues), and the same links can power email deep links.

### Step 5 — Receive completions (webhook)

LMS admin → **CRM & API** → set your webhook URL + signing secret. On every
course completion the LMS POSTs:

```json
{
  "event": "course_completed",
  "organization": "ambak",
  "employee_id": "AMB-1042",
  "email": "riya.sharma@ambak.com",
  "user_id": "…",
  "course_id": "…",
  "course_title": "Objection Handling",
  "score": 92,
  "passed": true,
  "completed_at": "2026-09-17T10:41:00.000Z"
}
```

Headers: `x-ambak-event: course_completed` and
`x-ambak-signature: sha256=<hex>` — the HMAC-SHA256 of the **raw body**
keyed by your secret. Verify before trusting:

```js
const expected = "sha256=" +
  crypto.createHmac("sha256", SECRET).update(rawBody).digest("hex");
if (expected !== req.headers["x-ambak-signature"]) return res.status(401).end();
```

Delivery is best-effort (5s timeout, one attempt) and never blocks the
learner. Reconcile any gaps with `learner-summary` — treat the webhook as a
cache-refresh signal, the summary as truth.

### Step 6 — Go-live checklist

- [ ] API key created on **production** and stored in the CRM's secret store
- [ ] Master-data values aligned between CRM and LMS (or mapped)
- [ ] Employee sync backfilled (loop over the roster; then event-driven)
- [ ] Learning section renders from `learner-summary`
- [ ] Click-through: card → sso-link → module → Back to CRM verified on
      desktop *and* one real phone
- [ ] Webhook receiver deployed, HMAC verified, tested with one real completion
- [ ] Leaver flow wired to `DELETE`
- [ ] Key rotation drill: revoke → create → swap secret (proves the runbook)

## 4. API reference

| Endpoint | Method | Auth | Purpose |
| --- | --- | --- | --- |
| `/api/integrations/sso-link` | POST | API key | Mint one-time signed login URL |
| `/api/integrations/learner-summary` | GET | API key | Full learning state for one employee |
| `/api/integrations/employees` | PUT | API key | Upsert (hire/update/rehire) by employee_id |
| `/api/integrations/employees` | GET | API key | Read one employee record |
| `/api/integrations/employees` | DELETE | API key | Deactivate (leaver) |
| `/api/integrations/enter` / `exit` | GET | browser | Embedded-mode cookies (used automatically; not called by the CRM) |

**Status codes:** `401` bad/revoked key · `403` admin account refused ·
`404` no active LMS account for that employee_id · `400` validation
(governance messages are admin-identical) · `402` user quota reached.
`warnings: []` on success responses = applied with noted skips.

## 5. Security model

- The API key is the **only** credential your app holds — the database
  service key is never shared, and everything a key can do is bounded by
  these endpoints and scoped to one org.
- SSO and sync **structurally cannot touch admin accounts** or escalate
  roles; a leaked key cannot yield admin access. Revocation is immediate.
- Keys are managed by the Super Owner only, with last-used timestamps for
  audit.

## 6. Known limits

- Completion webhooks fire from the SCORM path; **cmi5** course completions
  don't fire them yet (no practical impact for Storyline/Rise content —
  reconcile via `learner-summary` if you adopt cmi5).
- Email changes are LMS-admin-only by design.
- Webhook delivery is at-most-once; the summary endpoint is the source of
  truth.

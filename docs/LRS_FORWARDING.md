# External LRS Statement Forwarding — Architecture Design

**Status:** Proposed (for sign-off) · **Migration:** `0044_lrs_forwarding.sql` · **Ships after:** v1.0.5

## 1. Summary

Every tenant can point their organisation at an external LRS (Learning Record
Store) and receive a **real-time mirror copy of all xAPI statements** their
learners generate, while our **internal LRS keeps ingesting normally** so all
existing reports continue to work. This is a **standard, platform-wide
capability for every organisation** — no premium tier, no entitlement checks.
A tenant turns it on with a single `enabled` toggle after entering their LRS
endpoint + credentials.

This is a **fan-out**: each statement is (1) written to our `xapi_statements`
table as today, and (2) mirrored to the tenant's LRS via a durable,
non-blocking outbox.

## 2. Goals / Non-goals

**Goals**
- Available to **all organisations** out of the box (just configure + enable).
- Real-time copy in the happy path; **durable** (no statement silently lost) on
  transient LRS outages.
- **Never** block or fail the learner runtime or our own ingestion.
- Idempotent forwarding (safe retries).
- Self-serve config + a connection test for admins.

**Non-goals**
- No premium/tier/billing gating (explicitly dropped).
- Not replacing our internal LRS — we always keep our own copy (fan-out, not
  hand-off).
- Not a full xAPI LRS proxy (no statement querying against the external LRS from
  our UI).

## 3. Background & constraints (why the design is shaped this way)

- **Ingestion today:** cmi5/xAPI AUs authenticate with a Bearer token
  (`/api/xapi/fetch`) and POST/PUT to `app/api/xapi/statements/route.ts`, which
  upserts into `xapi_statements` (keyed `attempt_id` + `statement_id`) and runs
  `processStatement`. The org is derivable from the attempt
  (`course_attempts.organization_id`).
- **Runtime = Cloudflare Workers** (`@opennextjs/cloudflare`). No raw TCP, no
  long-lived processes. OpenNext builds a `fetch`-only Worker — **no `scheduled`
  handler** — which is why existing crons run via **GitHub Actions** hitting
  `/api/cron/*` with a `CRON_SECRET`. HTTP `fetch` to an external LRS is fully
  supported on Workers.
- **Implication:** background work must be **outbox-backed** (durable state in
  Postgres), drained by a fetch-triggered worker — not an in-memory queue that
  dies with the isolate.

## 4. High-level architecture

```
 AU (cmi5/xAPI in iframe)
        │  POST /api/xapi/statements   (Bearer auth)
        ▼
 ┌──────────────────────────────────────────────┐
 │ /api/xapi/statements  (existing)               │
 │  1. upsert xapi_statements   ← our internal LRS │  ← unchanged, always wins
 │  2. processStatement         ← completion logic │
 │  3. IF org.lrs.enabled:                         │
 │       insert lrs_forward_outbox (status=pending)│  ← cheap, synchronous
 │       ctx.waitUntil(forwardNow(rows))           │  ← real-time, post-response
 └──────────────────────────────────────────────┘
        │ (response returns to AU immediately)
        ▼
 lrs_forward_outbox  ──drained by──►  /api/cron/lrs-forward  ──HTTP──►  Tenant LRS
   (durable retry/backoff)             (GitHub Actions, retry net)      (/statements)
```

The learner's runtime is acknowledged the moment the statement is stored +
enqueued; the actual forward happens after the response (`waitUntil`) or, on
failure, on the next drainer pass.

## 5. Database — `supabase/migrations/0044_lrs_forwarding.sql`

### 5.1 `tenant_lrs_config` (one row per org, auto-provisioned)

> **No tier/activation flag.** The only switch is `enabled`. Every org gets a
> row automatically (backfill + trigger), so the feature is present platform-wide
> and an admin just fills in the endpoint and flips `enabled`.

| column | type | notes |
|---|---|---|
| `organization_id` | uuid PK → `organizations(id)` on delete cascade | |
| `enabled` | boolean **not null default false** | the single on/off toggle |
| `endpoint` | text | LRS base URL, e.g. `https://lrs.acme.com/xapi/` (trailing slash normalised) |
| `auth_key` | text | Basic-auth key / username |
| `auth_secret` | text | Basic-auth secret — **sensitive** |
| `xapi_version` | text not null default `'1.0.3'` | sent as `X-Experience-API-Version` |
| `last_test_at` | timestamptz | last connection-test time |
| `last_test_status` | text | `ok` \| `auth_failed` \| `unreachable` \| `error` |
| `last_test_error` | text | human-readable failure detail |
| `created_at` / `updated_at` | timestamptz not null default now() | |

**Auto-provisioning ("every org gets a row by default"):**
```sql
-- backfill existing orgs
insert into public.tenant_lrs_config (organization_id)
  select id from public.organizations
  on conflict (organization_id) do nothing;

-- and for every new org
create function public.create_default_lrs_config() returns trigger as $$
begin
  insert into public.tenant_lrs_config (organization_id)
  values (new.id) on conflict do nothing;
  return new;
end; $$ language plpgsql security definer;

create trigger trg_org_default_lrs_config
  after insert on public.organizations
  for each row execute function public.create_default_lrs_config();
```
A missing row is also treated as "disabled" defensively, so a failed backfill
never breaks ingestion.

### 5.2 `lrs_forward_outbox` (the queue / source of truth)

| column | type | notes |
|---|---|---|
| `id` | uuid PK default gen_random_uuid() | |
| `organization_id` | uuid not null (indexed) | denormalised for batching |
| `attempt_id` | uuid | provenance |
| `statement_id` | text not null | the xAPI statement id (idempotency key) |
| `payload` | jsonb not null | the raw statement (self-contained for drainer + dead-letter) |
| `status` | text not null default `'pending'` | `pending` \| `sent` \| `failed` \| `dead` |
| `attempts` | int not null default 0 | |
| `next_attempt_at` | timestamptz not null default now() | exponential backoff gate |
| `last_error` | text | |
| `created_at` | timestamptz default now() / `sent_at` timestamptz | |

Indexes: `(status, next_attempt_at)` (drainer scan), `(organization_id)`.
Unique `(organization_id, statement_id)` to avoid duplicate enqueues on retry.

### 5.3 RLS & secret handling

- Both tables have **RLS enabled**. Each gets an **admin-scoped SELECT policy**
  `using (is_org_admin(organization_id))` (migration `0045`) so an admin can
  read **only their own org's** row(s) — never another org's. **Writes have no
  client policy**, so only the service role (our API) can mutate them.
  - Why a policy at all (vs. policy-less deny-all): the cross-tenant RLS audit
    (`tests/rls-audit/audit.sql`) hard-FAILs any `organization_id` table with
    zero policies, because it can't *certify* isolation on a policy-less table.
    The admin-scoped policy clears the FAIL **and** passes the audit's runtime
    leak probe (org A's admin sees 0 of org B's rows).
- **`auth_secret` is never returned to the browser** — the config API masks it
  (`••••••`); the only direct-read exposure is an org's own admin reading their
  own credential.
- Secret at rest: **plaintext + RLS**, consistent with the existing
  `notification_settings.smtp_password`. *(Optional hardening: `pgcrypto`
  encryption — noted as a future step, not v1.)*

## 6. Backend engine

### 6.1 Ingestion hook — `app/api/xapi/statements/route.ts` (POST + PUT)

After the existing `xapi_statements` upsert + `processStatement`, add a
**fail-isolated, non-blocking** step:

```ts
// resolve org from the attempt (cached per request)
const orgId = await orgForAttempt(session.attemptId);
const cfg = orgId ? await loadLrsConfig(orgId) : null;       // service-role
if (cfg?.enabled && cfg.endpoint) {
  // 1) enqueue (cheap insert; the AU's 200 does not wait on the LRS)
  const rows = await enqueueForward(orgId, session.attemptId, statements);
  // 2) real-time best-effort forward AFTER the response is sent
  cloudflareCtx()?.waitUntil(forwardNow(cfg, rows).catch(() => {}));
}
```

Everything here is wrapped so a forwarding error **cannot** affect the status
returned to the AU or our own statement storage.

> **`waitUntil` note:** not currently used in the repo. We'll obtain the
> execution context via `getCloudflareContext().ctx` from `@opennextjs/cloudflare`.
> If it proves unavailable under OpenNext, the cron drainer still delivers
> (just not sub-second) — so correctness never depends on `waitUntil`, only
> latency does.

### 6.2 `lib/lrs/forward.ts`

`forwardStatements(cfg, statements[])`:
- `POST ${endpoint}/statements` with an **array body**, headers:
  `Authorization: Basic base64(key:secret)`, `X-Experience-API-Version: <cfg.xapi_version>`,
  `Content-Type: application/json`. Statements keep **their own ids** ⇒ the LRS
  dedups ⇒ **retries are idempotent**.
- Response classification:
  - `200/204` → **sent**
  - `409` (already stored) → treat as **sent**
  - `400/401/403/422` → **permanent** (don't retry; surface in `last_error`)
  - `5xx` / timeout / network → **retryable** (backoff)

### 6.3 Drainer — `app/api/cron/lrs-forward/route.ts` (NEW)

- Guarded by `x-cron-secret: <CRON_SECRET>` (same as other crons).
- Select `pending`/`failed` rows where `next_attempt_at <= now()`, cap ~200,
  **group per org**, forward as a batch, then update `status` / `attempts` /
  `last_error` and set `next_attempt_at = now() + backoff(attempts)`
  (e.g. `min(2^attempts, 3600)s`).
- **Dead-letter** after `attempts >= 8` → `status='dead'` (admin-visible).
- Register in `.github/workflows/cron.yml`.

### 6.4 Recommended queue approach

**Transactional outbox + hybrid drain** (no new infra; matches existing
patterns):
1. **Enqueue synchronously** → outbox is the source of truth.
2. **`waitUntil` immediate attempt** → real-time in the happy path.
3. **Cron drainer** → durable retry/backoff/dead-letter net.

**Honesty on "real-time":** GitHub-Actions cron is **not** real-time (≥5-min
cadence, may coalesce), so real-time delivery comes from the `waitUntil`
fast-path; the cron is the catch-up/retry layer (a few minutes of lag only when
the fast-path failed).

**Documented upgrade path (future):** a dedicated **Cloudflare Worker with a
Queues consumer** — ingestion does `env.LRS_QUEUE.send(row)`, the consumer
forwards with native retries + DLQ. It can drain the **same outbox**, so this is
forward-compatible and only worth adopting at high statement volume.

## 7. Validation — connection test

`app/api/org/lrs/test/route.ts` (admin-only): performs `GET ${endpoint}/about`
with the auth header + version — the canonical **side-effect-free** xAPI
connectivity + auth probe (returns the LRS's supported versions). Mapping:
- `200` → ✅ `ok` (persist `last_test_*`, show supported versions)
- `401/403` → `auth_failed` ("LRS rejected the key/secret")
- DNS/timeout/network → `unreachable` ("couldn't reach the endpoint")

We deliberately **do not** POST a test statement (that would pollute the
tenant's LRS).

## 8. UI — standard settings card (all admins)

A standard **"External LRS Integration"** card placed directly in the main
**organization settings** layout (alongside SMTP / branding), visible to **all
admins** — not gated:
- Inputs: `endpoint`, `auth_key`, `auth_secret` (masked), `xapi_version`.
- **Enable** toggle (`enabled`).
- **Test connection** button → calls the test route → green/red badge with the
  last result.
- A small **outbox health** readout: pending / failed / dead counts for the org,
  so admins can see delivery is flowing.
- One-line data-governance note: *"Enabling this sends a copy of your learners'
  xAPI activity to the LRS you configure."*

Config API: `app/api/org/lrs/route.ts` — `GET` (returns config **with the secret
masked**) / `POST` (admin-only upsert; writes secret only when a new value is
provided, never echoes it back).

## 9. Security & privacy
- `auth_secret` never leaves the server unmasked; service-role-only reads for
  actual use; admin RLS for config rows; outbox is service-role only.
- Forwarding learner data to a third-party LRS is the **tenant's** data-governance
  decision (their LRS, their DPA) — surfaced via the UI consent note.
- The connection test and forwards run server-side; credentials are never sent
  to the browser.

## 10. Failure modes & observability
- **LRS down / 5xx:** rows stay `pending`/`failed`, retried with backoff; our
  ingestion + reports are unaffected.
- **Bad credentials (401/403):** permanent-fail fast; admin sees it on the next
  Test and via `last_error`; rows dead-letter rather than retry forever.
- **Dead-letter:** `status='dead'` rows are surfaced in the settings card
  (count) for admin attention; a future "replay" action can re-queue them.
- **Logging:** drainer logs per-batch outcomes; ingestion logs are unchanged.

## 11. File inventory
```
NEW   supabase/migrations/0044_lrs_forwarding.sql     # tables + RLS + backfill + trigger
NEW   lib/lrs/forward.ts                              # build+send batch, classify responses
NEW   lib/lrs/config.ts                               # load/save config (service-role; masked reads)
NEW   app/api/org/lrs/route.ts                        # admin GET/POST config (secret masked)
NEW   app/api/org/lrs/test/route.ts                   # connection test (xAPI /about)
NEW   app/api/cron/lrs-forward/route.ts               # outbox drainer (CRON_SECRET)
MOD   app/api/xapi/statements/route.ts                # enqueue + waitUntil forward (POST + PUT)
MOD   lib/xapi/auth.ts (or session)                   # surface organization_id to the route
MOD   app/[org]/(admin)/settings/...                  # "External LRS Integration" card (all admins)
MOD   .github/workflows/cron.yml                      # schedule the drainer
(future) wrangler.toml + queue-consumer Worker        # Cloudflare Queues upgrade
```

## 12. Rollout / deploy ordering
1. Apply `0044_lrs_forwarding.sql` to **staging → prod** (backfills a row per org;
   trigger covers new orgs). Additive + safe.
2. Deploy the code (ingestion reads `enabled`; default `false` → **no behaviour
   change** for any org until an admin configures + enables).
3. Add the cron schedule + ensure `CRON_SECRET` parity (already set).
4. Resilient reads: if the config table/columns aren't present yet, ingestion
   treats forwarding as disabled — so deploying before the migration degrades
   gracefully.

## 13. Testing plan
- **Unit:** response classification in `lib/lrs/forward.ts` (200/204/409/4xx/5xx →
  sent/permanent/retryable); backoff math; secret masking on config GET.
- **Live (lifecycle, matches existing style):** seed an org, point it at a
  **mock LRS** (a tiny test endpoint that records POSTs), enable forwarding,
  drive a real cmi5 attempt, and assert: (a) `xapi_statements` written (internal
  copy intact), (b) the mock LRS received the same statement id(s), (c) with the
  mock LRS forced to 500, the outbox row goes `pending → sent` after the drainer
  runs (durability), (d) connection test returns `ok`/`auth_failed` correctly.

## 14. Open questions (sensible v1 defaults chosen)
- **Real-time bar:** v1 = `waitUntil` + cron retry. Cloudflare Queues = fast-follow
  if volume warrants.
- **Secret at rest:** v1 = plaintext + RLS (matches SMTP). `pgcrypto` = later.
- **Dead-letter replay:** v1 = surface counts; admin "replay" button = later.

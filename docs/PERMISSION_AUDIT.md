# API Permission Audit — 2026-09-09

One-pass, systematic audit of every API route's authorization, done as part
of launch readiness. Two layers: a **static scan** of all 83 `route.ts`
files under `app/api/`, then a **dynamic sweep** attacking the flagged
routes as three adversaries and asserting outcomes in the database.

## Method

**Static scan** classified every route by its gate:
- `auth.getUser` / `requireOrgAccess` + role check (`canManage`,
  `canViewReports`, explicit role lists) — the standard admin/session gate.
- `x-cron-secret` — scheduled endpoints.
- Platform-owner checks — `/api/super/*`.
- **Public by design** — anonymous auth flows (`auth/forgot-password/*`,
  `auth/magic-link`), token-based `invitations/accept`, org `theme`
  branding, the CSV `users/template`, and the xAPI runtime
  (`xapi/*` — gated by its own attempt-scoped bearer token, verified 401
  without it).
- **RLS-backed cookie routes** — no explicit session check in the handler;
  the cookie-bound client's writes are authorized by row-level security
  ("RLS is the final authority" house design). These were the dynamic
  sweep's targets, since a missing policy would fail silently.

**Dynamic sweep** (`verify-permsweep.mjs`, scratchpad harness, 34 checks):
three attackers — **anonymous**, a **same-org learner**, and a
**cross-org admin** (owner of a different tenant) — attempt every mutating
operation on the RLS-backed routes: course rename, team rename,
team-member add, learning-path rename, path-assignment delete, badge
rename/delete, announcement edit, plus assignment-create and user-create
on the explicitly gated routes and tokenless xAPI calls. Every probe
asserts **both** a non-success response **and** an unchanged database row.
Positive controls prove the org's real owner can perform the same
operations.

## Result: PASS (34/34) — with one defect found and fixed

| Finding | Severity | Outcome |
| --- | --- | --- |
| `DELETE /api/gamification/badges/[id]` returned `{ok:true}` to non-admins — RLS blocked the delete (0 rows) but the route reported false success | Low (no data damage or leak; misleading response only) | **Fixed same day**: the route now requires row-level proof of the mutation and returns 403 otherwise |
| `POST /api/users` validates required fields before checking the caller's role, so unauthorized callers with an incomplete body get 400 instead of 401/403 | Informational | Accepted: the 400 names missing fields only; the role gate still runs before any write. Convention note for new routes: prefer auth-first ordering |

No privilege escalation, cross-tenant access, or unauthorized mutation was
possible on any probed route. Middleware redirects anonymous callers
(307 → /login); RLS hides foreign orgs from cross-tenant admins (404).

## Standing conventions this audit confirms

1. Every mutating route is authorized by **at least one** of: an explicit
   session + role check, or an RLS policy on the touched table. Routes that
   rely on RLS alone must return proof-of-mutation (select after write)
   rather than trusting `error == null`.
2. Service-role clients are only reached **after** the gate (or inside
   fan-outs whose trigger was a gated write).
3. Cron endpoints require `x-cron-secret`; xAPI requires the attempt token.

## Re-running

Seed/attack/verify is self-contained: run the harness against a dev server
pointed at staging, then `--purge`. Re-run after adding any route that
relies on RLS alone, or wire its probe into the harness.

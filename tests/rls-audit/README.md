# RLS Cross-Tenant Isolation Audit

The single most catastrophic class of bug a B2B multi-tenant SaaS can ship is
cross-tenant data leakage. The Playwright `tenant-isolation.spec.ts` covers
this at the **API layer**: it verifies that admin-of-Org-A can't list, create,
or mutate Org-B data via our public HTTP routes.

This audit covers it at the **database layer**, which is the real defense.
An API-layer bug is a single-route fix. A missing or broken RLS policy means
*any* missed org-membership check in *any* future route is a data leak.

This script verifies, for every table in `public` with an `organization_id`
column:

1. Row-level security is enabled on the table.
2. At least one policy exists.
3. Policy text mentions `organization_id` or `auth.uid()`.
4. **At runtime, an authenticated user in Org A sees zero rows of Org B.**

Check (4) is the only one that catches a *logically broken* policy. Static
checks 1–3 only catch "missing entirely."


## How to run

Pick whichever fits your workflow. Both run the same `audit.sql` script.

### Manual — Supabase SQL Editor (staging)

1. Open your **staging** Supabase project (never production).
2. SQL Editor → New query → paste the contents of `audit.sql` → Run.
3. Inspect the result table. Every row's `status` column should be `OK`.
   Any `FAIL` blocks the launch.

The script refuses to run if the database name contains `prod` as a sanity
guard. Override only by renaming or running statements manually.

### Scripted — psql

```bash
# Get a direct Postgres connection string from:
#   Supabase Dashboard → Project Settings → Database → Connection string (URI)
# Use the STAGING project's URL.

export SUPABASE_DB_URL='postgres://...staging...'
psql "$SUPABASE_DB_URL" -f tests/rls-audit/audit.sql
```

Exit code is non-zero if any FAIL was raised, which makes this CI-friendly:

```yaml
# .github/workflows/rls-audit.yml
name: RLS Audit
on:
  schedule: [{ cron: '0 7 * * 1' }]   # every Monday at 07:00 UTC
  workflow_dispatch: {}
jobs:
  audit:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: psql "${{ secrets.SUPABASE_STAGING_DB_URL }}" -f tests/rls-audit/audit.sql
```


## What the output looks like

```
 table                  | rls | policies | rows_A | rows_B | B_sees_A | A_sees_B | status
------------------------+-----+----------+--------+--------+----------+----------+--------
 announcements          | t   |        3 |      4 |      6 |        0 |        0 | OK
 courses                | t   |        4 |      2 |      3 |        0 |        0 | OK
 enrollments            | t   |        3 |      8 |     11 |        0 |        0 | OK
 organization_members   | t   |        5 |      1 |      1 |        0 |        0 | OK
 ...

 fails | warns | oks | total
-------+-------+-----+-------
     0 |     0 |  14 |    14
```

Column meanings:

- `rls` — whether `ENABLE ROW LEVEL SECURITY` is set on the table.
- `policies` — number of policies attached to the table.
- `rows_A`, `rows_B` — service-role (RLS-bypassed) ground-truth counts.
- `B_sees_A` — rows of Org A that user B's session was actually able to see.
  **Must be 0.**
- `A_sees_B` — rows of Org B that user A's session was actually able to see.
  **Must be 0.**
- `status` — `OK`, `WARN`, or `FAIL: <reason>`.


## When the runtime check is skipped

The runtime check needs **two organizations that each have at least one
member**. If your DB only has one org (fresh staging, for example), the
runtime columns will be `0` and the static checks still run. To prime
staging, run the e2e suite first — it leaves `qa-*` orgs behind that the
audit can use:

```bash
npm run test:e2e -- --grep "@smoke"   # creates qa-* orgs
psql "$SUPABASE_DB_URL" -f tests/rls-audit/audit.sql
```

Or seed two orgs manually via the admin UI.


## What this does NOT cover

- **Platform-level tables** that intentionally span tenants:
  `platform_owners`, `platform_subscriptions`, `platform_audit_log`,
  `platform_impersonation_sessions`, `plans`, `broadcasts`. Access is
  restricted to platform owners via `require-platform-owner.ts` and the IP
  allowlist middleware, not RLS-by-org. If you add a new platform-level
  table, add a separate guard test for it (the Playwright
  `tenant-isolation.spec.ts` already covers `super/tenants`).

- **Tables whose tenant column isn't named `organization_id`**. The
  discovery query keys off that column name. If you introduce a table that
  scopes by some other name (`org_id`, `tenant_id`, etc.), either rename it
  or hand-add it to the audit. Search the codebase periodically with
  `grep -r "_org_id" supabase/migrations` to catch drift.

- **Non-`SELECT` leaks via the service-role client.** This audit runs as
  `authenticated`, which is the role end users hit. If application code
  uses the service role without an org-membership guard, the audit can't
  see that. The Playwright API-layer test catches *that* class — keep
  both.

- **Storage buckets.** Supabase Storage has its own RLS surface. Add a
  separate audit for buckets if you store per-tenant files.


## When this fails

Any `FAIL` row is launch-blocking. Common causes and fixes:

| Symptom                                          | Likely cause                                                                                  | Fix                                                                              |
|--------------------------------------------------|-----------------------------------------------------------------------------------------------|----------------------------------------------------------------------------------|
| `FAIL: RLS not enabled`                          | Migration forgot `alter table ... enable row level security;`                                 | Add it to the next migration.                                                    |
| `FAIL: No policies`                              | RLS enabled but no policy → everything is denied for non-superusers (or open if no FORCE)     | Add `create policy ... using (...)` per role.                                    |
| `FAIL: user_A leaked N rows from Org B`          | Policy logic is wrong — usually a missing join through `organization_members`                 | Audit the policy text. Compare against a known-good table.                       |
| `WARN: policy doesn't reference organization_id` | Policy may rely on `auth.uid()` indirectly via a view or function — usually fine but suspect  | Read the policy. Confirm it terminates at an org-membership check.               |


## Maintenance

Run this:

- Once before launch.
- After every migration that touches a new table or alters RLS.
- On a weekly cron against staging.

If you ever see a FAIL in a previously-green run, halt deploys until it's
back to green.

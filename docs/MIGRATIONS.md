# Database migrations — conventions

Migrations live in `supabase/migrations/NNNN_name.sql` and are applied **by
hand** (paste into the Supabase SQL editor), staging first, then production.
Never `supabase db push` — the CLI is linked to production.

## Every migration

- Idempotent: `create table if not exists`, `add column if not exists`,
  `drop policy if exists` before `create policy`, guarded constraints.
- Ends with `notify pgrst, 'reload schema';` so the Data API sees the change.
- Deploy-safe in both orders: code that reads a new column must tolerate it
  being absent (select `*`, treat `undefined` as the default) and code that
  writes it must only do so when a value is supplied.

## Data API grants (mandatory from 2026-10-30)

Supabase no longer grants Data API access to **new** relations in `public`
automatically. Every table, view or materialized view a migration creates
must be granted in the **same file**, or supabase-js gets `permission denied`
for it — on production that is a broken feature after a hand-applied
migration. Row-level security still decides which rows a role sees; the grant
is only the table-level prerequisite.

Tables:

```sql
grant select on public.<table> to anon;                                   -- omit if never read before login
grant select, insert, update, delete on public.<table> to authenticated;
grant select, insert, update, delete on public.<table> to service_role;
```

Views and materialized views (read-only):

```sql
grant select on public.<view> to authenticated, service_role;             -- service_role only for admin-only report views
```

Identity / serial columns also need the sequence:

```sql
grant usage, select on all sequences in schema public to authenticated, service_role;
```

Functions called through `rpc()`:

```sql
grant execute on function public.<fn>(<args>) to authenticated, service_role;
```

`scripts/check-migration-grants.mjs` enforces the relation rule for every
migration from 0073 onward and runs in CI (`pr-checks` → lint job). Run it
locally with `node scripts/check-migration-grants.mjs` (`--all` lists the
pre-rule history as well, for information only).

Which role needs what: browser and server components use the signed-in
user's session (`authenticated`); pre-login pages use `anon`; API routes,
cron jobs and matview readers use `service_role`. When in doubt, grant
`authenticated` and `service_role` and let RLS do the restricting.

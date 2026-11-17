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

## Paste order across files (ADR 0024)

Each file's header is the full rule; this is the cross-file summary.

- Production sitting (ADR 0024 step 74, with the note of 2026-11-16, D-S2,
  recommended and awaiting the owner's answer): 0105, 0106,
  `0107_learning_contexts.sql`, `0112_sweep_time_box.sql`, the release tag,
  `0108_drop_context_derive.sql`, 0109. 0112 goes directly after 0107, so
  no deployed route meets 0107's refresh bodies (the sweep with no time box)
  with learners.
- **0112** (the completion sweep's time box and its own calls; five
  functions, no relation, no row write): written and rehearsed
  (`scripts/migration-rehearsal`, scenarios `0107-then-0112` and
  `0107-0112-then-0107-then-0112`); **not yet pasted on staging or
  production** (2026-11-16). Staging paste: the owner, in the SQL editor, as
  soon as its pull request is merged, with the read-only reads before and
  after that its header lists (the note's S3); record the date here.
  Reverse: `ops/0112-reverse.sql`, staging only (`ops/0107-reverse.sql`
  drops 0112's two functions too); if the staging job of the note's D-S3 was
  scheduled, `select cron.unschedule('completion-sweep');` comes first,
  before `ops/0112-reverse.sql` or `ops/0107-reverse.sql`, in the same
  sitting.
- After 0112, every later paste of 0107 (staging, until 0109) is followed by
  0112, and by 0108 if 0108 was pasted: 0107's refresh bodies run the sweep
  without the time box. On production 0107 is never pasted again after
  0112.
- 0112 refuses after 0109 (it would strip 0109's views from the refresh
  functions). After 0109 neither 0107 nor 0112 is pasted again. 0109 (not
  written yet) recreates both refresh functions calling
  `sweep_completion_side_effects_timed(200, 1500)`, asserts it in its
  after-check, lists 0112 among its never-paste files, and its reverse
  restores 0112's refresh bodies.

## Paste order: the platform sender (ADR 0029)

- **0113** (`platform_email_log`, the platform sender's log; one table,
  deny-all, service role select and insert only): written and rehearsed
  (`scripts/migration-rehearsal`, scenarios `0113-defaults` and
  `0113-no-defaults`); **not yet pasted on staging or production**
  (2026-11-17). Independent of 0107 to 0112: it needs only
  `public.organizations` and `auth.users`. Pasted **before** the code of
  ADR 0029 pull request A on each environment (decision 7); code that
  arrives first sends no platform mail and its health check reads `fail`
  until the paste. Rows are kept 90 days (the delete statement is in the
  file's header and `ops/RUNBOOK.md` §6.3). Reverse: `ops/0113-reverse.sql`,
  after the code is rolled back.
- 0114 (`tenant_smtp_state`, ADR 0029 pull request B) is not written yet.

## Paste order: membership status (ADR 0030)

- **0115** (`0115_membership_status_enforced.sql`: the four membership
  helpers and the seven policies that read `organization_members`
  themselves count a membership only while its status is `active` and its
  organisation's `deleted_at` is null; no relation, no row write, nothing
  removed): written and rehearsed (`scripts/migration-rehearsal`, scenarios
  `0115-at-0104`, `0107-0112-then-0115`, `0115-then-sitting`,
  `0115-then-0107-again`, `0115-undone-then-0115`, `0115-extra-policy`,
  `0115-missing-policy`, `0115-no-analyst-helper` and
  `0115-with-0110-stand-in`); **not yet pasted on staging or production**
  (2026-11-18). Before each paste the owner runs its before-check (section
  0b of the file, one read-only select) and answers every row whose verdict
  is not `ok` or `info`, and keeps the `B11` rows whole with the record of
  the sitting (the stored definitions, the reverse's source for an object
  marked `DIFFERS`); record the date here after each paste.
- Staging: 0115 first, then the full e2e and lifecycle regression on the
  older code and lifecycle spec 80's database group by hand
  (`tests/bot/lifecycle/80-membership-status-access.spec.ts`; it fails, and
  never skips, on a database without 0115), then the app code (ADR 0030
  pull request B). Production: 0115
  in a small sitting of its own once staging is green, ahead of ADR 0024's
  sitting and without changing it; the code with the next tag. 0115 touches
  nothing defined after 0056, so it is pasted before or after 0105 to 0114.
  On production 0110 (ADR 0026) always comes after 0115; whichever of the two
  is pasted second, `ops/0115-after-checks.sql` is run after it.
- The re-paste rule: After 0115, none of 0001, 0002, 0006, 0010, 0019, 0026, 0027, 0030, 0031, 0055 and 0056 is pasted again on that database. If one is pasted, 0115 is pasted again directly after it, in the same sitting, and its after-checks are read. Where 0110 is applied and the file was 0027, 0110 follows 0115. A paste of 0105, 0106, 0107, 0108 or 0112 needs nothing from 0115. The after-checks of 0115 are also kept as a read-only block that can be run alone (`ops/0115-after-checks.sql`); it is run after every sitting that pastes a migration, whatever its number.
  `tests/unit/membership-rule-migrations.test.ts` holds the list of this
  sentence equal to its own, and fails any other migration that restates a
  helper or one of the seven policies without the rule, or that adds a
  function or a view reading `organization_members` with `auth.uid()`
  without it.
- Reverse: `ops/0115-reverse.sql`, for a paste that went wrong only (it
  brings back the old rule). A code rollback needs no reverse.

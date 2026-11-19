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
- **0114** (`0114_tenant_smtp_state.sql`, ADR 0029 pull request B): adds
  `tenant_smtp_state` (each tenant's mail health, owed alert and daily cap),
  `mail_job_counts` (a daily count of reset-code and sign-in-link jobs,
  written only through `mail_job_mark`), `tenant_mail_status` (one call that
  returns a tenant's state with its sent count of the past 24 hours) and one
  index on `notification_log`. Written and rehearsed
  (`scripts/migration-rehearsal`: `0114-defaults`, `0114-no-defaults`,
  `0114-at-0104`, `0114-with-0115`, `0114-then-0115`, `0114-drift`); **not
  pasted on staging or production yet** (2026-11-19). The two tables are
  deny-all and service-role only (select, insert, update; never delete); the
  two functions are security invoker and only the service role executes
  them. It needs nothing past 0021, and 0115 may be pasted before or after
  it. Paste it **ahead of** pull request B's code (preferred; code that comes
  first treats a tenant with complete settings as able to send, applies no
  cap and writes no job marks). Reverse with `ops/0114-reverse.sql` once the
  code is rolled back; it loses any daily caps a platform owner set, and its
  header shows the select that saves them first.
- **0117** (`0117_account_setup_links.sql`, ADR 0029 pull request B): one
  deny-all table for the LMS's own "set your password" links (rule N9).
  `service_role` may select the table, insert five named columns and update
  two, and has no delete, so only the database decides when a link expires.
  Written and rehearsed (`0117-defaults`, `0117-no-defaults`); **not pasted
  on staging or production yet** (2026-11-19). It needs only
  `public.organizations` and `auth.users`. It **must** be pasted ahead of
  pull request B's code (code that comes first turns away an add with no
  password before creating any account). Rows are kept 90 days, with the
  clean-up statement in the file's header. Reverse with
  `ops/0117-reverse.sql` once the code is rolled back; links already mailed
  then stop working.
- **The 0114 and 0117 sitting** (ADR 0029, checklist D7). The pull request's
  first push carries only these files (the two migrations, their reverses,
  the pre-check, the rehearsal and this page), no app code, and its single
  independent review reads the two migrations then. On staging, with the
  owner at the SQL editor (role selector on postgres, never the Supabase
  CLI) and while no spec, CI e2e run or harness is running:
  1. Run `ops/0114-0117-before-checks.sql` by itself. It only reads and
     always gives 27 rows; save them all as a file. If any row says
     `REFUSES`, or anything looks unexpected, stop: paste nothing and send
     the rows to the architect.
  2. Paste 0114 in full. A success message means its built-in after-checks
     passed.
  3. Paste 0117 in full.
  4. Run `ops/0115-after-checks.sql` by itself, once, as after any sitting
     ("DO" then "ROLLBACK" is a pass).
  5. Run the pre-check again: all rows `ok` or `info`, with P19 showing
     both files pasted. Note the date on this page.

  Only after that is the app code pushed. Each file's section 0 tests the
  same facts the pre-check reports and stops before creating anything, and
  each file is a single transaction, so a stopped or failed paste leaves no
  trace. Production gets its own sitting, before the tag that carries the
  code, run by the owner after it has been explained: 0113 first if
  production lacks it (with its own checks), then steps 1 to 5, doing step
  4 only if 0115 is on production by then. The rehearsal covers staging's
  sitting as `0114-0117-sitting` and production's as `0114-0117-at-0104`
  and `0114-0117-at-0104-with-0115`.

## Paste order: membership status (ADR 0030)

- **0115** (`0115_membership_status_enforced.sql`: the four membership
  helpers and the seven policies that read `organization_members`
  themselves count a membership only while its status is `active` and its
  organisation's `deleted_at` is null; no relation, no row write, nothing
  removed but one legacy policy, where the database has it): written and
  rehearsed (`scripts/migration-rehearsal`, scenarios
  `0115-at-0104`, `0107-0112-then-0115`, `0115-then-sitting`,
  `0115-then-0107-again`, `0115-undone-then-0115`, `0115-extra-policy`,
  `0115-missing-policy`, `0115-no-analyst-helper`,
  `0115-with-0110-stand-in`, `0115-hand-made`, `0115-hand-made-at-0104` and
  `0115-hand-made-off-list`); **not yet applied on staging or production**
  (2026-11-18; a first staging paste that day was refused by its section 0c
  and changed nothing). Before each paste the owner runs its before-check (section
  0b of the file, one read-only select) and answers every row whose verdict
  is not `ok` or `info`, and keeps the `B11` rows whole with the record of
  the sitting (the stored definitions, the reverse's source for an object
  marked `DIFFERS` and for the alias "members_view_their_orgs" marked
  `RENAMES`, and, in parts and not as statements, the whole text of the
  alias "View own membership" marked `RENAMES` and of a policy marked
  `DROPS`); record the date here after each paste.
- Hand-made databases (ADR 0030, note "Hand-made databases, 2026-11-18").
  The before-check marks two closed lists. `RENAMES`: "members_view_their_orgs"
  on `organizations` and "View own membership" on `organization_members`,
  older names of "members can read their orgs" and "members can read own
  memberships"; the paste gives them the repository's names (and the
  second the spelling `(user_id = auth.uid())`), and nobody's access changes
  by that. Where the B3 row of "members can read their orgs" says its text
  differs, section 3 writes 0115's text over it: the owner reads that
  alias's `B11` row whole before the paste (B3 prints it cut short), and
  where the row says the roles are not the repository's, the policy keeps
  them under the repository name. `DROPS`: "admins_view_org_enrollments" on
  `public.enrollments`, a table no migration creates and the app never
  reads; the paste removes that one policy, so a signed-in session no longer
  reads that table through it (the service role is not affected, and no
  row, grant or setting of the table changes); its row says whether row
  security is on and how many permissive policies for select or all stay,
  `B11` prints the policy whole in parts, and `B12` prints the table's row
  security, the select, insert, update and delete grants of `anon` and of
  `authenticated`, and the names of the other permissive policies on the
  table, any command (`LIST` where row security is off: a finding of its own
  for the owner, which the paste neither changes nor waits for). The removal
  runs only after the table is locked and the policy read again under the
  lock with the before-check's own tests (that name on that table,
  permissive, for select, its text naming `organization_members`). Both
  lists are closed: anything else on such a database still reads `REFUSES`
  or `UNEXPECTED`, and the paste is refused or rolled back and changes
  nothing. Expected on staging: no `REFUSES`, no `UNEXPECTED`, three
  `RENAMES`, one `DROPS`, `B12` as it reads (`info` with row security on),
  and B7 to B9 as before; any other row that is not `ok` or `info`, but for
  a `B12` `LIST`, means no paste. The reverse does not rename back and does
  not restore the removed policy.
- A standing `DIFFERS` after the paste (a production question only:
  staging's aliases carry the repository's roles). Where the `RENAMES` row
  of "members_view_their_orgs" said its roles are not the repository's
  (`public`), the policy keeps those roles under the repository name, so
  from that paste on every run of the before-check reads `B3` "members can
  read their orgs" `DIFFERS` on its roles. That row is expected and is not a
  failed paste: the after-checks test the policy's command, not its roles,
  and pass. It goes to the architect, with the `RENAMES` row of the first
  paste beside it. The own-row alias gets no such row: `B4b` and the
  after-check A4 compare its text and command, never its roles, so roles
  other than the repository's stay under the repository name with `B4b`
  reading `ok`; its `B4b` row prints them on every run, its `RENAMES` row
  of the first paste says they are not the repository's, and its `B11` row
  of that paste records them. The line above (any other
  row means no paste) is about staging's first paste, where this row cannot
  arise.
- Staging: 0115 first, then the full e2e and lifecycle regression on the
  older code and lifecycle spec 80's database group by hand
  (`tests/bot/lifecycle/80-membership-status-access.spec.ts`; it fails, and
  never skips, on a database without 0115), then the app code (ADR 0030
  pull request B). Production: 0115
  in a small sitting of its own once staging is green, ahead of ADR 0024's
  sitting and without changing it; the code with the next tag. Before that
  sitting, besides its before-check, every policy on the tables of ADR 0030
  section C is listed read-only, as on staging: the before-check lists only
  the policies, functions and views that read `organization_members`, and a
  database set up by hand can carry other ones. 0115 touches
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
  brings back the old rule). A code rollback needs no reverse. It gives no
  alias its old name back and does not restore the policy removed from
  `public.enrollments`; that policy is written back by hand from its `B11`
  row on the owner's word only, and from then on
  `ops/0115-after-checks.sql` run alone fails on that database (A4) and the
  next paste of 0115 removes it again. After the reverse, only the `B11` row
  of "members_view_their_orgs" is run (where its text differed); the `B11`
  row of "View own membership" is printed in parts, not as a statement, and
  is never written back (the own-row policy keeps the repository's spelling,
  and the alias's spelling would make the next paste of 0115 roll back on
  A4).

# Migration rehearsal (v1.3.0)

The free local copy the owner chose on 2026-10-18 for the v1.3.0 practice run (`docs/release/v1.3.0.md` §7). It replays the repository's migrations on an embedded Postgres ([PGlite](https://pglite.dev) 0.5.10, Postgres 18.6) with a small Supabase shim and synthetic rows, runs `ops/release-v1.3.0-audit.sql` before and after the sitting exactly as the owner will paste it, and compares every result with `expectations.json`.

No network database, no credentials, no production or staging data. Nothing is written inside the repository.

## Run it

```bash
node scripts/migration-rehearsal/run.mjs                  # every scenario
node scripts/migration-rehearsal/run.mjs prod gap         # some scenarios
node scripts/migration-rehearsal/run.mjs --verbose        # also print each audit grid (synthetic rows)
```

PGlite is not a project dependency (`package.json` is not changed for it):

- `PGLITE_DIR=<folder>` uses an existing install: an `npm install --prefix <folder>` folder, or the package folder itself.
- Without `PGLITE_DIR`, the runner installs `@electric-sql/pglite@0.5.10` once into `<system temp>/lms-migration-rehearsal-pglite-0.5.10` with `npm --prefix` (`--ignore-scripts`, no lock file) and reuses it afterwards. It never installs into the repository's `node_modules`.

The runner needs only Node; it has been run on Node 22 (as CI does) and Node 24. It prints, for each scenario, every migration file applied (and re-applied where the sitting pastes it twice), and for each audit run the expected and actual value of each named check, the exact set of `MISMATCH` rows for that moment, `Z90`, and the read-only proof. The last line is `RESULT: PASS` or `RESULT: FAIL`. Exit code 0 = every check passed, 1 = a check failed, 2 = the run could not start.

CI runs the same command: `.github/workflows/migration-rehearsal.yml`, on every pull request and push that touches `supabase/migrations/**`, `ops/release-*.sql`, this folder or the workflow, and on demand (Actions → Migration rehearsal → Run workflow).

## Files

| File | What it is |
|---|---|
| `run.mjs` | the runner (Node only) |
| `expectations.json` | the pinned PGlite version, the scenarios and their steps, and every expected result |
| `shim.sql` | the Supabase surface the migrations and the audit need: roles (`anon`, `authenticated`, `service_role`, …), `auth.users`, `auth.uid()/role()/jwt()`, `storage.buckets/objects` and helpers |
| `shim-dashboard.sql` | `public.set_updated_at()`, made in the dashboard before the migrations existed (see "Repository gap") |
| `seed.sql`, `seed-0071.sql` | synthetic rows that make every data check read something (shared storage prefix, inactive package with a learner's and a staff member's in-progress attempt, wrong default, cmi5 completion after 20 s with only a screen-level statement, webhook and LRS endpoint with credentials in the URL, a `qa-*` organisation with an abandoned-but-completed, cross-organisation attempt) |
| `seed-hotfix.sql`, `seed-many.sql`, `asrole-grants.sql` | extras for one scenario each |
| `repoint.sql` | the repoint after 0098 refuses on the shared prefix |
| `assert-0100.sql` | scenario `p4-0100`: what `0100_alds_core.sql` must have done (every object, once, and no `xapi_statements` foreign key or index yet, those come with 0101; the backfill; the guard on the tier and manifest columns and the writer, also as `service_role`; the refusals; the delete guards on `is_preview`; `anon` and `authenticated` locked out), in one transaction that ends in `rollback` |
| `fixtures/0073_attempt_scoring_rules.at-1375511.sql` | scenarios `prod-asfound-*`: `0073_attempt_scoring_rules.sql` as it was at commit 1375511 (#114, 2026-09-18), byte for byte under a header that names the commit; the copy production most likely holds (the owner's audit of 2026-10-19 found 0072 and a 0073 there). The only later change to the file, #170 (5240d80, 2026-10-14), added its explicit Data API grants. A rehearsal fixture, never a migration |
| `assert-0073-grants.sql` | scenarios `prod-asfound-a*`: after the current 0073 is re-pasted, the grants it names exist, directly (`has_table_privilege` and `information_schema.role_table_grants`): `anon` select, `authenticated` and `service_role` select/insert/update/delete on `attempt_scoring_rules`; `authenticated` and `service_role` select on `v_course_attempt_scoring` and `v_course_attempt_summary`. Read-only |
| `assert-0073-grants-absent.sql` | scenarios `prod-asfound-b*`: without the re-paste, the nine table grants on `attempt_scoring_rules` are absent on PGlite (no default privileges), while the four view grants exist (0082 and 0090 recreate the views and grant them). Read-only |

## Scenarios and what each one proves

| Scenario | Steps | Expected |
|---|---|---|
| `prod` | 0001–0071 without 0032 (production's believed state); seed; audit; the sitting: 0032 and 0072–0098, each pasted twice, 0098 first refused by its own guard on the shared prefix (`P0001`, "0098 refused: 1 storage_prefix value(s) are shared …", not a unique-index error), then `repoint.sql`, then 0098 twice; audit; 0099 twice; `refresh_report_views()`; audit | every file applies and re-applies without error; 0098 refuses while `D02` = 1; the three audits match `exp_before`, `exp_after` and `exp_0099` except the seeded `qa-*` organisation (`A03`, before and after) and, before the repoint, the seeded shared prefix (`D02`); `Z90` = `2 / 46 / 50`, `40 / 1 / 5`, `45 / 6 / 0`; every 0072–0098 probe (first and end-of-file) absent before and present after the sitting and after 0099; `B0099*` flip only after 0099; the six report views refresh without error |
| `hotfix` | 0001–0071 with 0032 (the out-of-band hotfix already applied) plus a course-level duplicate pair | `C05` = `per-package only`, `C03` = 1, `C04` = 0 |
| `below0071` | 0001–0069 | `B0070`, `B0071a`, `B0071b` absent and mismatched (the "production below 0071" stop rule fires) |
| `gap` | 0072–0075 and 0077 applied, 0076 missing | `Z01` = `0076`, `Z02` = `0077` (the "applied out of order" stop rule fires) |
| `asrole` | the audit run as `authenticated` with Supabase-like default grants | row-level security makes every D row read 0 (`D02` reads `ok`, `A03` reads 0 although a `qa-*` organisation exists); `A04` is the only mismatch, which is why it is a stop rule |
| `many` | 1,001 more courses | `D04.01003` listed, 1,003 `D04` rows, no check id collision |
| `no-dashboard-fn` | the shim without `public.set_updated_at()` | the replay stops at `0049_security_advisor_hardening.sql` with `42883` (function does not exist) |
| `p4-0100` | the `prod` scenario's steps through 0099 and its refresh; then 0100 (P4 alds core, ADR 0005 note (a) of 2026-10-19) pasted twice; `assert-0100.sql`; `refresh_report_views()`; audit | 0100 applies and re-applies without error; `assert-0100.sql` passes and rolls back; after 0100 only `B0100a`–`d` mismatch (they read `present`; every D row as after 0099 in `prod`), `Z90` = `49 / 10 / 4`; the six report views refresh without error |
| `prod-asfound-a` | production as found by the owner's read-only audit of 2026-10-19: 0001–0071 without 0032, 0072 (current file; unchanged since 2d62d67), the 1375511 copy of 0073 (`fixtures/`), **no rows** (production has no courses, attempts, webhooks or LRS configs); audit; variant (a) of the sitting: 0032, 0072 and the **current** 0073 re-pasted, then 0074–0098, each pasted twice; audit; `assert-0073-grants.sql`; 0099 twice; `refresh_report_views()`; audit; `assert-0073-grants.sql` again | the first audit reproduces production's result exactly: only `B0073`/`B0073b` mismatch (`exp_before` absent), `B0072` present, every `B0074`–`B0098` probe absent, `B0099b`–`d` present, `C05` = `legacy only`, `A03` and every D row 0, `Z01` = `0074`, `Z02` = `none`, `Z90` = `2 / 41 / 46`; then every file applies and re-applies, every `at_after` reads ok (`Z90` = `39 / 0 / 5`), every `at_0099` reads ok (`Z90` = `44 / 5 / 0`, as on staging); the current 0073's grants exist after the sitting and after 0099 |
| `prod-asfound-b` | the same start and audit; variant (b): 0032, then 0074–0098, each pasted twice (0072 and 0073 not re-pasted); audit; `assert-0073-grants-absent.sql`; 0099 twice; refresh; audit; the grants file again | the same three audit results as `prod-asfound-a`; the only difference is the table grants of 0073, absent here (on Supabase, variant (b) relies on the default privileges every pre-2026-10-30 relation received, which this harness cannot model) |
| `prod-asfound-a-seeded`, `prod-asfound-b-seeded` | the two variants with the `prod` scenario's synthetic rows (`seed.sql`, `seed-0071.sql`) after the as-found start, so every data path runs; 0098 is first refused on the shared prefix and applied after `repoint.sql`, as in `prod` | before: `A03`, `B0073`, `B0073b`, `D02` mismatch, `Z90` = `4 / 43 / 47` (the two seeded rows on top of production's result); after the sitting `[A03]`, `Z90` = `40 / 1 / 5`; after 0099 none, `Z90` = `45 / 6 / 0`; grants as in the unseeded variant |

Every audit run is also checked to be read-only, in two ways:

- Dynamically, before and after each run, in `public`, `auth` and `storage`: every relation with its kind and storage file (`relfilenode`, which a rewrite, truncate, reindex or non-concurrent refresh changes), every row of every table and materialized view (count and md5), every sequence's state, and the session's settings (a `set` or `set_config` that outlives the paste). A failure names what changed, never row contents.
- Statically, on the file's code with comments removed and string literals emptied in one left-to-right pass: no write but its temporary table (`insert`, `update`, `delete`, `truncate`, DDL, `grant`, `set`, `copy`, `call`, `perform`, `execute`, `refresh`, `lock`, `nextval`, …), no call to any function the migrations or the shim create (qualified or not; the audit calls none, so reading through one would need a reviewed change here), and no call to a side-effecting built-in (`set_config`, `pg_notify`, `pg_sleep`, `pg_terminate_backend`, …).

The dynamic check sees only what changes on the synthetic rows: a call that happens to change nothing here (for example `refresh_report_views()`, whose views are empty on these rows and refresh concurrently) leaves no trace, and only the static check catches it. The grid is also searched for the seeded credentials (user, password, token, secret), which must never appear.

Results on 2026-10-18 (branch `feat/p1-release-prep`, PGlite 0.5.10, Node 22 and Node 24): `RESULT: PASS: 229 checks, 0 failed` over the seven scenarios; the sitting's first pastes took 0.14–0.26 s in total, depending on the run and the machine, and 0099 under 0.05 s (toy data). The audit grids are identical, row for row, to those of the first replay, made the same day in a temporary folder before this harness existed (its logs are not kept in the repository), except `A01`, the run time. On 2026-10-19 (branch `feat/p4-lms-side`, with the `p4-0100` scenario added): `RESULT: PASS: 370 checks, 0 failed` over the eight scenarios. On 2026-10-19 (branch `chore/v1.3.0-prod-as-found`, from main `d34ee7d`, with the four `prod-asfound*` scenarios added after the owner's production audit): `RESULT: PASS: 870 checks, 0 failed` over the twelve scenarios.

## Repository gap it found

A replay from the repository alone stops at `0049_security_advisor_hardening.sql`: it runs `alter function public.set_updated_at() set search_path = …`, and no migration creates `public.set_updated_at()`. The function was created in the Supabase dashboard before the migrations existed, so production and staging have it and a fresh project built from `supabase/migrations/` does not. The harness creates it in `shim-dashboard.sql`; the `no-dashboard-fn` scenario keeps the gap visible. Closing it would take a new migration (a schema change, outside this harness).

## What it cannot prove

- Anything that depends on production's real rows: duplicate version-number pairs, shared storage prefixes, the 0032 constraint state, rows a new constraint or trigger would refuse. The read-only audit run on production before the sitting is designed to catch exactly these, and its stop rules hold the sitting (`docs/release/v1.3.0.md` §2.3 item 11, §4.2).
- Supabase itself: its Postgres version (PGlite is 18.6), its roles, grants, default privileges, extensions and row-level security, and the SQL editor's batch and confirmation behaviour. The staging SQL-editor applies of 0072–0099 are the evidence there.
- That last night's dump restores into a Supabase project, and timing on production's compute.

## When it fails

Read the `FAIL` lines. A changed migration or audit file that changes a result on purpose needs `expectations.json` updated in the same change, with the reason in the commit message. A migration added after 0099 is not part of the v1.3.0 sitting: it is rehearsed by its own scenario (0100 by `p4-0100`), never by the `prod` one.
